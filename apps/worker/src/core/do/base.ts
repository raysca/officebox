import { apiError, err, ok, WS_PING, WS_PONG, type ApiError, type Result } from "@officebox/shared";
import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";
import type { Env } from "../../env";
import { rootLogger, type Logger } from "../log";
import { backoffMs } from "./backoff";
import { Outbox, type OutboxOptions } from "./outbox";
import { getAttachment, setAttachment } from "./websocket";

/**
 * Base class for every Officebox Durable Object (TDD §2.2, §3.2, §6.5; AGENTS §4.2).
 *
 * **Schema versioning with lazy migration.** A subclass lists its SQLite migrations in `migrations()`.
 * On the first wake after a deploy, the constructor applies the ones not yet applied, inside
 * `blockConcurrencyWhile`, each in its own transaction together with the new `schema_version` in
 * `meta`. Thousands of objects therefore never need a coordinated migration. If a migration throws,
 * its transaction rolls back, the data is left untouched, and the object refuses work with
 * `unavailable` (`fetch` returns 503, sockets are closed, `rpc()` returns the error, alarms do
 * nothing) until a fixed release ships. A schema newer than the code (after a rollback) is
 * tolerated: expand/contract keeps it compatible. The base class's own tables are versioned the same
 * way under `meta.core_schema_version`.
 *
 * **Alarm multiplexer.** A Durable Object has one alarm. Named timers live in the `core_timers` table
 * and the alarm is always set to the earliest one. Handlers are registered per timer *kind*: a timer
 * named `poll:01J…` runs the `poll` handler.
 * - Timers are durable, so they survive eviction, and the alarm is re-derived from the table on
 *   every wake and after every change (never trusted from memory across a rolled-back transaction).
 * - A timer is removed only after its handler succeeds, and only if nothing rescheduled it while it
 *   ran, so a run is idempotent.
 * - A handler that throws or exceeds its timeout (30 s by default) is retried with exponential
 *   backoff without blocking the other timers; past 5 attempts each failure logs at error level.
 *   A timed-out handler is abandoned, not cancelled: handlers must tolerate running twice.
 * - A timer whose kind has no handler is kept (it may belong to a newer release) and retried with
 *   backoff; only kinds listed with `retireTimerKind` are dropped.
 *
 * **WebSockets.** Keepalive `ping` frames are answered with `pong` by the runtime without waking the
 * object. Subclasses implement `onSocketMessage`, `onSocketClose` and `onSocketError`, which the base
 * class only calls once the schema is usable. `acceptSocket` and `sockets` keep typed attachments.
 *
 * **Typed RPC results.** Public methods called over RPC return `Promise<RpcResult<T>>` and never
 * throw an expected denial; the runtime logs thrown errors as uncaught exceptions (spike finding).
 * Wrap the body in `this.rpc(() => ...)` so a failed migration is reported as a result too. Return
 * types must be concrete: no `unknown` or `any` fields (spike finding). `RpcMethodsReturnResults`
 * checks this at compile time.
 *
 * **Hibernation rules (TDD §3.2).** The constructor only checks the schema version and the alarm; no
 * D1 calls, no state rebuilds, and no `setInterval`/`setTimeout` that would keep the object awake.
 * Subclass constructors must follow the same rule and may only register timer handlers and outboxes.
 */

export interface DoMigration {
  /** 1, 2, 3, … in order, with no gaps. */
  version: number;
  description: string;
  /** Runs inside a transaction. Must only use `sql`; never read instance fields. */
  up(sql: SqlStorage): void;
}

/** Result of a Durable Object RPC method: plain data that survives structured cloning. */
export type RpcResult<T> = Result<T, ApiError>;

/**
 * Compile-time check that every public method of a Durable Object (beyond the base class) returns
 * `Promise<RpcResult<…>>`. Resolves to `true`, or to the names of the offending methods.
 */
export type RpcMethodsReturnResults<T> = {
  [K in Exclude<keyof T, keyof CoreDurableObject>]: T[K] extends (...args: never[]) => Promise<RpcResult<unknown>>
    ? never
    : K;
}[Exclude<keyof T, keyof CoreDurableObject>] extends never
  ? true
  : {
      [K in Exclude<keyof T, keyof CoreDurableObject>]: T[K] extends (...args: never[]) => Promise<RpcResult<unknown>>
        ? never
        : K;
    }[Exclude<keyof T, keyof CoreDurableObject>];

export interface Timer {
  /** Full name, for example `poll:01J…`. */
  name: string;
  kind: string;
  /** The part after the first `:`, or null. */
  id: string | null;
  dueAt: number;
  /** JSON text given to `setTimer`, or null. */
  payload: string | null;
  /** Failed runs so far. */
  attempts: number;
}

export type TimerHandler = (timer: Timer) => void | Promise<void>;

export interface TimerHandlerOptions {
  /** How long a run may take before it counts as failed. Defaults to `DEFAULT_TIMER_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface SetTimerOptions {
  payload?: string | null;
  /**
   * Batching: if the timer already exists with an earlier or equal due time, leave it exactly as it
   * is (due time, payload, attempts). If that timer is running right now, it is marked as changed so
   * it runs again rather than being removed when the current run finishes.
   */
  ifEarlier?: boolean;
}

const TIMER_KIND = /^[a-z][a-z0-9_]*$/;
/** Timers run per alarm; more due timers are picked up by the next alarm, set straight away. */
export const TIMER_BATCH = 100;
export const DEFAULT_TIMER_TIMEOUT_MS = 30_000;
/** Outbox drains send to Queues and may take longer than an ordinary timer. */
const OUTBOX_TIMER_TIMEOUT_MS = 5 * 60_000;
/** From this many failed runs, each further failure logs at error level. */
export const TIMER_ERROR_ATTEMPTS = 5;

/** Tables owned by the base class, versioned separately (`meta.core_schema_version`). */
const CORE_MIGRATIONS: readonly DoMigration[] = [
  {
    version: 1,
    description: "timers and outbox",
    up(sql) {
      sql.exec(`CREATE TABLE IF NOT EXISTS core_timers (
        name TEXT PRIMARY KEY,
        due_at INTEGER NOT NULL,
        payload TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0
      )`);
      sql.exec("CREATE INDEX IF NOT EXISTS core_timers_due ON core_timers(due_at)");
      sql.exec(`CREATE TABLE IF NOT EXISTS core_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        body TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      sql.exec("CREATE INDEX IF NOT EXISTS core_outbox_due ON core_outbox(stream, next_attempt_at, id)");
    },
  },
  {
    version: 2,
    description: "dead outbox rows",
    up(sql) {
      sql.exec(`CREATE TABLE IF NOT EXISTS core_outbox_dead (
        id INTEGER PRIMARY KEY,
        stream TEXT NOT NULL,
        body TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        dead_at INTEGER NOT NULL
      )`);
      sql.exec("CREATE INDEX IF NOT EXISTS core_outbox_dead_stream ON core_outbox_dead(stream, id)");
    },
  },
];

function checkMigrationList(list: readonly DoMigration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`DO migrations must be numbered 1..n in order; got ${m.version} at ${i}`);
  });
}

/** Stands in for `this` when `migrations()` is probed: any property access means it reads instance state. */
const INSTANCE_PROBE: object = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`migrations() must not read instance fields (read ${String(property)})`);
    },
  },
);

class TimerTimeout extends Error {}

type TimerRow = {
  name: string;
  due_at: number;
  payload: string | null;
  attempts: number;
  generation: number;
};

export abstract class CoreDurableObject<E extends Env = Env> extends DurableObject<E> {
  protected readonly sql: SqlStorage;
  protected readonly log: Logger;
  private migrationFailure: string | null = null;
  private readonly timerHandlers = new Map<string, { handler: TimerHandler; timeoutMs: number }>();
  private readonly retiredKinds = new Set<string>();
  private readonly outboxes = new Map<string, Outbox>();
  /** Timers whose handler is running now. */
  private readonly runningTimers = new Set<string>();
  /** Alarm time as last read from or written to storage; `undefined` until first read. */
  private alarmAt: number | null | undefined = undefined;
  private alarmFlushQueued = false;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Log the object's name and a short ID prefix; full 64-hex IDs are redacted as token-like.
    this.log = rootLogger.child({
      durableObject: this.constructor.name,
      objectName: ctx.id.name ?? null,
      objectId: ctx.id.toString().slice(0, 16),
    });
    // Answered by the runtime without waking a hibernated object (TDD §3.2).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_PING, WS_PONG));
    // If this callback threw, the runtime would reset the object and every request would fail with
    // the same error; migrate() therefore catches and records failures instead of throwing.
    void ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.alarmAt = await ctx.storage.getAlarm();
      if (this.migrationFailure === null) this.flushAlarm();
    });
    this.onTimer("outbox", (timer) => this.drainOutbox(timer), { timeoutMs: OUTBOX_TIMER_TIMEOUT_MS });
  }

  /** The subclass's SQLite migrations, oldest first. Must not depend on instance fields. */
  protected migrations(): readonly DoMigration[] {
    return [];
  }

  // ------------------------------------------------------------------ schema

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    try {
      this.applyMigrations("core_schema_version", CORE_MIGRATIONS);
      this.applyMigrations("schema_version", this.migrations.call(INSTANCE_PROBE));
    } catch (error) {
      this.migrationFailure = error instanceof Error ? error.message : String(error);
      this.log.error("durable object schema migration failed; refusing work", { error });
    }
  }

  private applyMigrations(metaKey: string, list: readonly DoMigration[]): void {
    checkMigrationList(list);
    const current = Number(this.getMeta(metaKey) ?? "0");
    if (current > list.length) {
      this.log.warn("durable object schema is newer than this code", { metaKey, stored: current, code: list.length });
      return;
    }
    for (const migration of list.slice(current)) {
      this.ctx.storage.transactionSync(() => {
        migration.up(this.sql);
        this.setMeta(metaKey, String(migration.version));
      });
      this.log.info("durable object schema migrated", { metaKey, version: migration.version });
    }
  }

  /** Applied schema version of the subclass's migrations. */
  protected get schemaVersion(): number {
    return Number(this.getMeta("schema_version") ?? "0");
  }

  protected getMeta(key: string): string | null {
    const row = this.sql.exec<{ value: string | null }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  protected setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** `Ok` when the schema is usable; the `unavailable` error otherwise. */
  protected ready(): RpcResult<void> {
    return this.migrationFailure === null
      ? ok()
      : err(apiError("unavailable", "This item is temporarily unavailable while an upgrade is fixed."));
  }

  /** Runs an RPC method body, returning `unavailable` instead if the schema migration failed. */
  protected async rpc<T>(body: () => RpcResult<T> | Promise<RpcResult<T>>): Promise<RpcResult<T>> {
    const ready = this.ready();
    if (!ready.ok) return ready;
    return body();
  }

  override async fetch(request: Request): Promise<Response> {
    const ready = this.ready();
    if (!ready.ok) return Response.json({ error: ready.error }, { status: 503 });
    return this.onFetch(request);
  }

  /** HTTP and WebSocket-upgrade handler for subclasses. Defaults to 404. */
  protected onFetch(_request: Request): Response | Promise<Response> {
    return Response.json({ error: apiError("not_found", "No such endpoint.") }, { status: 404 });
  }

  // --------------------------------------------------------------- websockets

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.ready().ok) {
      ws.close(1011, "unavailable");
      return;
    }
    await this.onSocketMessage(ws, message);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    if (!this.ready().ok) return;
    await this.onSocketClose(ws, code, reason, wasClean);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    if (!this.ready().ok) return;
    await this.onSocketError(ws, error);
  }

  /** A message from an accepted socket. Not called while the schema is unusable. */
  protected onSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void | Promise<void> {}

  protected onSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void | Promise<void> {}

  protected onSocketError(_ws: WebSocket, _error: unknown): void | Promise<void> {}

  /**
   * Accepts a hibernatable WebSocket with a typed attachment and returns the 101 response for the
   * client. `tags` let `sockets(tag)` find it later (at most 10 tags per socket).
   */
  protected acceptSocket<S extends z.ZodType>(schema: S, attachment: z.input<S>, tags: string[] = []): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, tags);
    setAttachment(server, schema, attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Open sockets (optionally with `tag`) and their attachments; sockets whose attachment no longer parses are skipped. */
  protected sockets<S extends z.ZodType>(schema: S, tag?: string): Array<[WebSocket, z.infer<S>]> {
    const out: Array<[WebSocket, z.infer<S>]> = [];
    for (const ws of this.ctx.getWebSockets(tag)) {
      const attachment = getAttachment(ws, schema);
      if (attachment !== null) out.push([ws, attachment]);
    }
    return out;
  }

  // ------------------------------------------------------------------ timers

  /** Registers the handler for timers of `kind` (`kind` or `kind:<id>`). Call from the constructor. */
  protected onTimer(kind: string, handler: TimerHandler, options: TimerHandlerOptions = {}): void {
    if (!TIMER_KIND.test(kind)) throw new Error(`Invalid timer kind: ${kind}`);
    this.timerHandlers.set(kind, { handler, timeoutMs: options.timeoutMs ?? DEFAULT_TIMER_TIMEOUT_MS });
  }

  /** Declares a timer kind that an earlier release used and this one no longer handles: such timers are dropped. */
  protected retireTimerKind(kind: string): void {
    this.retiredKinds.add(kind);
  }

  /**
   * Creates or moves the timer `name` to `dueAt` (epoch ms). Synchronous, so it can run inside
   * `ctx.storage.transactionSync` with the state change it belongs to. The alarm is updated after the
   * current synchronous work (and so after the transaction commits or rolls back), from the table.
   */
  protected setTimer(name: string, dueAt: number, options: SetTimerOptions = {}): void {
    const kind = name.split(":", 1)[0] ?? "";
    if (!TIMER_KIND.test(kind)) throw new Error(`Invalid timer name: ${name}`);
    const payload = options.payload ?? null;
    const due = Math.floor(dueAt);
    const keepIfEarlier = options.ifEarlier ? 1 : 0;
    const running = this.runningTimers.has(name) ? 1 : 0;
    this.sql.exec(
      `INSERT INTO core_timers (name, due_at, payload, attempts, generation) VALUES (?1, ?2, ?3, 0, 0)
       ON CONFLICT (name) DO UPDATE SET
         due_at = CASE WHEN ?4 AND core_timers.due_at <= excluded.due_at THEN core_timers.due_at ELSE excluded.due_at END,
         payload = CASE WHEN ?4 AND core_timers.due_at <= excluded.due_at THEN core_timers.payload ELSE excluded.payload END,
         attempts = CASE WHEN ?4 AND core_timers.due_at <= excluded.due_at THEN core_timers.attempts ELSE 0 END,
         generation = CASE WHEN ?4 AND core_timers.due_at <= excluded.due_at AND NOT ?5
           THEN core_timers.generation ELSE core_timers.generation + 1 END`,
      name,
      due,
      payload,
      keepIfEarlier,
      running,
    );
    this.syncAlarm();
  }

  protected cancelTimer(name: string): void {
    this.sql.exec("DELETE FROM core_timers WHERE name = ?", name);
    this.syncAlarm();
  }

  protected getTimer(name: string): Timer | null {
    const row = this.sql
      .exec<TimerRow>("SELECT name, due_at, payload, attempts, generation FROM core_timers WHERE name = ?", name)
      .toArray()[0];
    return row ? toTimer(row) : null;
  }

  /**
   * Schedules the alarm to be re-derived from `core_timers` once the current synchronous work is
   * done. Deferring past `transactionSync` means a rolled-back timer never moves the alarm.
   */
  protected syncAlarm(): void {
    if (this.alarmFlushQueued) return;
    this.alarmFlushQueued = true;
    queueMicrotask(() => this.flushAlarm());
  }

  /** Points the alarm at the earliest timer, or clears it. Writes only when it changes. */
  private flushAlarm(): void {
    this.alarmFlushQueued = false;
    const row = this.sql.exec<{ due: number | null }>("SELECT MIN(due_at) AS due FROM core_timers").toArray()[0];
    const due = row?.due ?? null;
    if (due === this.alarmAt) return;
    this.alarmAt = due;
    if (due === null) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(due);
  }

  /** Runs due timers. Subclasses register handlers with `onTimer` instead of overriding this. */
  override async alarm(): Promise<void> {
    // The alarm that woke us has been consumed; re-derive it from the table when we're done.
    this.alarmAt = null;
    if (this.migrationFailure !== null) return;
    const due = this.sql
      .exec<TimerRow>(
        "SELECT name, due_at, payload, attempts, generation FROM core_timers WHERE due_at <= ? ORDER BY due_at, name LIMIT ?",
        Date.now(),
        TIMER_BATCH,
      )
      .toArray();

    for (const row of due) await this.runTimer(row);
    this.flushAlarm();
  }

  private async runTimer(row: TimerRow): Promise<void> {
    const timer = toTimer(row);
    if (this.retiredKinds.has(timer.kind)) {
      this.log.info("dropping timer of a retired kind", { timer: timer.name });
      this.sql.exec("DELETE FROM core_timers WHERE name = ? AND generation = ?", row.name, row.generation);
      return;
    }
    const entry = this.timerHandlers.get(timer.kind);
    if (!entry) {
      // Possibly from a newer release (before a rollback): keep it, retry later.
      this.retryTimer(row, "no handler for timer kind; keeping it", undefined);
      return;
    }
    this.runningTimers.add(row.name);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => entry.handler(timer)),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new TimerTimeout()), entry.timeoutMs);
        }),
      ]);
      // Removed only if nothing rescheduled it while it ran (which bumps the generation).
      this.sql.exec("DELETE FROM core_timers WHERE name = ? AND generation = ?", row.name, row.generation);
    } catch (error) {
      const timedOut = error instanceof TimerTimeout;
      this.retryTimer(
        row,
        timedOut ? "timer handler timed out; will retry" : "timer handler failed; will retry",
        timedOut ? undefined : error,
      );
    } finally {
      clearTimeout(deadline);
      this.runningTimers.delete(row.name);
    }
  }

  private retryTimer(row: TimerRow, message: string, error: unknown): void {
    const attempts = row.attempts + 1;
    const fields = { timer: row.name, attempts, ...(error === undefined ? {} : { error }) };
    if (attempts >= TIMER_ERROR_ATTEMPTS) this.log.error(message, fields);
    else this.log.warn(message, fields);
    this.sql.exec(
      "UPDATE core_timers SET attempts = ?, due_at = ? WHERE name = ? AND generation = ?",
      attempts,
      Date.now() + backoffMs(attempts),
      row.name,
      row.generation,
    );
  }

  // ------------------------------------------------------------------ outbox

  /**
   * Creates the outbox for one stream (normally one per queue). Call from the constructor or a field
   * initialiser. See `outbox.ts`.
   */
  protected createOutbox(options: OutboxOptions): Outbox {
    if (this.outboxes.has(options.stream)) throw new Error(`Outbox ${options.stream} already exists`);
    const outbox = new Outbox(this.sql, options, (dueAt) =>
      this.setTimer(`outbox:${options.stream}`, dueAt, { ifEarlier: true }),
    );
    this.outboxes.set(options.stream, outbox);
    return outbox;
  }

  private async drainOutbox(timer: Timer): Promise<void> {
    const outbox = timer.id === null ? undefined : this.outboxes.get(timer.id);
    if (!outbox) throw new Error(`Timer ${timer.name} names an unknown outbox stream`);
    const next = await outbox.drain(this.log);
    // Reschedule for the earliest remaining row; this bumps the timer's generation so it is kept.
    if (next !== null) this.setTimer(timer.name, Math.max(next, Date.now()));
  }
}

function toTimer(row: TimerRow): Timer {
  const separator = row.name.indexOf(":");
  return {
    name: row.name,
    kind: separator < 0 ? row.name : row.name.slice(0, separator),
    id: separator < 0 ? null : row.name.slice(separator + 1),
    dueAt: row.due_at,
    payload: row.payload,
    attempts: row.attempts,
  };
}
