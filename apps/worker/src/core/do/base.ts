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
 * `unavailable` (`fetch` returns 503 and `rpc()` returns the error) until a fixed release ships. A
 * schema newer than the code (after a rollback) is tolerated: expand/contract keeps it compatible.
 *
 * **Alarm multiplexer.** A Durable Object has one alarm. Named timers live in the `core_timers` table
 * and the alarm is always set to the earliest one. Handlers are registered per timer *kind*: a timer
 * named `poll:01J…` runs the `poll` handler. Timers are durable, so they survive eviction; running
 * them is idempotent (a timer is removed only after its handler succeeds, and only if the handler
 * didn't reschedule it); a failing handler is retried with exponential backoff without blocking the
 * other timers.
 *
 * **WebSockets.** Keepalive `ping` frames are answered with `pong` by the runtime without waking the
 * object. `acceptSocket` and `sockets` keep typed attachments with each socket (see `websocket.ts`).
 *
 * **Typed RPC results.** Public methods called over RPC return `RpcResult<T>` and never throw an
 * expected denial; the runtime logs thrown errors as uncaught exceptions (spike finding). Wrap the
 * body in `this.rpc(() => ...)` so a failed migration is reported as a result too. Return types must
 * be concrete: no `unknown` or `any` fields (spike finding).
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

export interface SetTimerOptions {
  payload?: string | null;
  /** Keep an existing timer's due time when it is already earlier (used for batching). */
  ifEarlier?: boolean;
}

const TIMER_KIND = /^[a-z][a-z0-9_]*$/;
const TIMER_BATCH = 100;

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
];

function checkMigrationList(list: readonly DoMigration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`DO migrations must be numbered 1..n in order; got ${m.version} at ${i}`);
  });
}

export abstract class CoreDurableObject<E extends Env = Env> extends DurableObject<E> {
  protected readonly sql: SqlStorage;
  protected readonly log: Logger;
  private migrationFailure: string | null = null;
  private readonly timerHandlers = new Map<string, TimerHandler>();
  private readonly outboxes = new Map<string, Outbox>();
  /** Alarm time last read or written; `undefined` until read in the constructor. */
  private alarmAt: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.log = rootLogger.child({ durableObject: this.constructor.name, objectId: ctx.id.toString() });
    // Answered by the runtime without waking a hibernated object (TDD §3.2).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_PING, WS_PONG));
    void ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.alarmAt = await ctx.storage.getAlarm();
      if (this.migrationFailure === null) this.syncAlarm();
    });
    this.onTimer("outbox", (timer) => this.drainOutbox(timer));
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
      this.applyMigrations("schema_version", this.migrations());
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

  // ------------------------------------------------------------------ timers

  /** Registers the handler for timers of `kind` (`kind` or `kind:<id>`). Call from the constructor. */
  protected onTimer(kind: string, handler: TimerHandler): void {
    if (!TIMER_KIND.test(kind)) throw new Error(`Invalid timer kind: ${kind}`);
    this.timerHandlers.set(kind, handler);
  }

  /**
   * Creates or moves the timer `name` to `dueAt` (epoch ms) and updates the alarm. Synchronous, so it
   * can run inside `ctx.storage.transactionSync` with the state change it belongs to.
   */
  protected setTimer(name: string, dueAt: number, options: SetTimerOptions = {}): void {
    const kind = name.split(":", 1)[0] ?? "";
    if (!TIMER_KIND.test(kind)) throw new Error(`Invalid timer name: ${name}`);
    const payload = options.payload ?? null;
    const due = Math.floor(dueAt);
    this.sql.exec(
      `INSERT INTO core_timers (name, due_at, payload, attempts, generation) VALUES (?, ?, ?, 0, 0)
       ON CONFLICT (name) DO UPDATE SET
         due_at = CASE WHEN ? AND core_timers.due_at <= excluded.due_at THEN core_timers.due_at ELSE excluded.due_at END,
         payload = excluded.payload, attempts = 0, generation = core_timers.generation + 1`,
      name,
      due,
      payload,
      options.ifEarlier ? 1 : 0,
    );
    this.syncAlarm();
  }

  protected cancelTimer(name: string): void {
    this.sql.exec("DELETE FROM core_timers WHERE name = ?", name);
    this.syncAlarm();
  }

  protected getTimer(name: string): Timer | null {
    const row = this.sql
      .exec<{
        name: string;
        due_at: number;
        payload: string | null;
        attempts: number;
      }>("SELECT name, due_at, payload, attempts FROM core_timers WHERE name = ?", name)
      .toArray()[0];
    return row ? toTimer(row) : null;
  }

  /** Points the alarm at the earliest timer, or clears it. Cheap when nothing changed. */
  protected syncAlarm(): void {
    const row = this.sql.exec<{ due: number | null }>("SELECT MIN(due_at) AS due FROM core_timers").toArray()[0];
    const due = row?.due ?? null;
    if (due === this.alarmAt) return;
    this.alarmAt = due;
    if (due === null) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(due);
  }

  /** Runs due timers. Subclasses register handlers with `onTimer` instead of overriding this. */
  override async alarm(): Promise<void> {
    // The alarm that woke us has been consumed.
    this.alarmAt = null;
    if (this.migrationFailure !== null) return;
    const now = Date.now();
    const due = this.sql
      .exec<{
        name: string;
        due_at: number;
        payload: string | null;
        attempts: number;
        generation: number;
      }>(
        "SELECT name, due_at, payload, attempts, generation FROM core_timers WHERE due_at <= ? ORDER BY due_at, name LIMIT ?",
        now,
        TIMER_BATCH,
      )
      .toArray();

    for (const row of due) {
      const timer = toTimer(row);
      const handler = this.timerHandlers.get(timer.kind);
      if (!handler) {
        this.log.error("no handler for timer; dropping it", { timer: timer.name });
        this.sql.exec("DELETE FROM core_timers WHERE name = ? AND generation = ?", row.name, row.generation);
        continue;
      }
      try {
        await handler(timer);
        // Removed only if the handler didn't reschedule it (which bumps the generation).
        this.sql.exec("DELETE FROM core_timers WHERE name = ? AND generation = ?", row.name, row.generation);
      } catch (error) {
        const attempts = row.attempts + 1;
        this.log.error("timer handler failed; will retry", { timer: timer.name, attempts, error });
        this.sql.exec(
          "UPDATE core_timers SET attempts = ?, due_at = ? WHERE name = ? AND generation = ?",
          attempts,
          Date.now() + backoffMs(attempts),
          row.name,
          row.generation,
        );
      }
    }
    this.syncAlarm();
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
    if (!outbox) {
      this.log.error("timer for an unknown outbox stream", { timer: timer.name });
      return;
    }
    const next = await outbox.drain(this.log);
    // Reschedule for the earliest remaining row; this bumps the timer's generation so it is kept.
    if (next !== null) this.setTimer(timer.name, Math.max(next, Date.now()));
  }

  // --------------------------------------------------------------- websockets

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
}

function toTimer(row: { name: string; due_at: number; payload: string | null; attempts: number }): Timer {
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
