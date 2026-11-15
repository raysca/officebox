import { apiError, err, ok } from "@officebox/shared";
import { z } from "zod";
import { CoreDurableObject, type DoMigration, type RpcResult, type Timer } from "../../src/core/do/base";
import type { Outbox } from "../../src/core/do/outbox";

/**
 * Test-only Durable Object exercising the core base class: lazy migrations, the alarm multiplexer,
 * the outbox (with a fake queue sender controlled through `meta`), WebSocket attachments and typed RPC.
 */

const MIGRATIONS: readonly DoMigration[] = [
  {
    version: 1,
    description: "items",
    up(sql) {
      sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
      sql.exec("CREATE TABLE timer_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, payload TEXT)");
      sql.exec("CREATE TABLE sent (seq INTEGER PRIMARY KEY AUTOINCREMENT, batch INTEGER NOT NULL, body TEXT NOT NULL)");
    },
  },
  {
    version: 2,
    description: "item notes",
    up(sql) {
      // Data-driven failure so a test can make this migration fail without changing code.
      const fail = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'fail_v2'").toArray()[0];
      sql.exec("ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT ''");
      if (fail?.value === "1") throw new Error("migration v2 failed on purpose");
    },
  },
];

export const socketAttachmentSchema = z.object({ userId: z.string(), role: z.enum(["admin", "member"]) });

export interface ItemRow {
  id: string;
  name: string;
  note: string;
}

export class TestObject extends CoreDurableObject {
  readonly outbox: Outbox;
  private batches = 0;
  private gateOpen = false;
  private gateWaiting = 0;
  /** Calls to the fake sender, successful or not. */
  private sendCalls = 0;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.outbox = this.createOutbox({
      stream: "test",
      send: (bodies) => this.fakeSend(bodies),
      sendTimeoutMs: () => Number(this.getMeta("send_timeout_ms") ?? "100"),
      maxSendsPerDrain: () => Number(this.getMeta("max_sends") ?? "32"),
      maxDrainMs: () => Number(this.getMeta("max_drain_ms") ?? "240000"),
      // No jitter unless a test asks: deterministic retry times keep alarm timing predictable.
      jitter: () => Number(this.getMeta("jitter") ?? "0"),
    });
    this.onTimer("record", (timer) => this.record(timer));
    this.onTimer("flaky", (timer) => {
      if (this.getMeta("flaky_fail") === "1") throw new Error("flaky handler failed");
      this.record(timer);
    });
    this.onTimer("again", (timer) => {
      this.record(timer);
      if (timer.attempts === 0 && this.getMeta("again_done") !== "1") {
        this.setMeta("again_done", "1");
        this.setTimer(timer.name, Date.now() + 60_000);
      }
    });
    // Waits, polling with real timers (I/O, like a production handler), until the test opens the
    // gate, so a test can act at a known point while the handler is mid-I/O. (Awaiting a bare promise
    // resolved by another request instead holds up that request's storage writes.)
    this.onTimer(
      "gated",
      async (timer) => {
        this.gateWaiting += 1;
        while (!this.gateOpen) await new Promise((resolve) => setTimeout(resolve, 5));
        this.record(timer);
      },
      { timeoutMs: 10_000 },
    );
    this.onTimer("hang", () => new Promise<void>(() => {}), { timeoutMs: 50 });
    this.retireTimerKind("old");
  }

  protected override migrations(): readonly DoMigration[] {
    return MIGRATIONS;
  }

  private record(timer: Timer): void {
    this.sql.exec("INSERT INTO timer_log (name, payload) VALUES (?, ?)", timer.name, timer.payload);
  }

  /**
   * Fake queue `sendBatch`: fails while `meta.outbox_fail` is "1", or when the batch holds a body
   * with `poison: true`; otherwise records the batch.
   */
  private async fakeSend(bodies: unknown[]): Promise<void> {
    this.sendCalls += 1;
    // Held until the test releases it (or the outbox's send timeout gives up first).
    if (this.getMeta("outbox_hang") === "1") await this.hangUntilReleased();
    const delay = Number(this.getMeta("send_delay_ms") ?? "0");
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.getMeta("outbox_fail") === "1") throw new Error("queue unavailable");
    const failAfter = Number(this.getMeta("outbox_fail_after") ?? "-1");
    if (failAfter >= 0 && this.sendCalls > failAfter) throw new Error("queue went down");
    if (bodies.some((b) => (b as { poison?: boolean }).poison === true)) throw new Error("message rejected");
    const failIds = (this.getMeta("fail_ids") ?? "").split(",").filter(Boolean);
    if (bodies.some((b) => failIds.includes((b as { id?: string }).id ?? ""))) throw new Error("rejected for now");
    this.batches += 1;
    for (const body of bodies) {
      this.sql.exec("INSERT INTO sent (batch, body) VALUES (?, ?)", this.batches, JSON.stringify(body));
    }
  }

  // ------------------------------------------------------------------ RPC

  version(): Promise<RpcResult<{ schemaVersion: number }>> {
    return this.rpc(() => ok({ schemaVersion: this.schemaVersion }));
  }

  /** Writes an item and its outbox message in one transaction. */
  addItem(id: string, name: string, payloadBytes = 0, poison = false): Promise<RpcResult<{ id: string }>> {
    return this.rpc(() => {
      if (name === "") return err(apiError("validation_failed", "Name required."));
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("INSERT INTO items (id, name) VALUES (?, ?)", id, name);
        this.outbox.enqueue({ type: "test.item", id, name, pad: "x".repeat(payloadBytes), poison });
      });
      return ok({ id });
    });
  }

  /** Adds `count` items in one transaction (one call, so no drain runs in between). */
  addItems(prefix: string, count: number): void {
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < count; i++) {
        const id = `${prefix}${String(i).padStart(4, "0")}`;
        this.sql.exec("INSERT INTO items (id, name) VALUES (?, ?)", id, prefix);
        this.outbox.enqueue({ type: "test.item", id });
      }
    });
  }

  denied(): Promise<RpcResult<{ secret: string }>> {
    return this.rpc(() => err(apiError("forbidden", "Not allowed.")));
  }

  items(): Promise<RpcResult<ItemRow[]>> {
    return this.rpc(() =>
      ok(this.sql.exec<{ id: string; name: string; note: string }>("SELECT * FROM items ORDER BY id").toArray()),
    );
  }

  timer(name: string, dueAt: number, payload: string | null = null, ifEarlier = false): void {
    this.setTimer(name, dueAt, { payload, ifEarlier });
  }

  /** Sets a timer inside a transaction that then rolls back. */
  rolledBackTimer(name: string, dueAt: number): string {
    try {
      this.ctx.storage.transactionSync(() => {
        this.setTimer(name, dueAt);
        throw new Error("roll back");
      });
    } catch (error) {
      return error instanceof Error ? error.message : "error";
    }
    return "committed";
  }

  timerRows(): Array<{ name: string; due_at: number; payload: string | null; attempts: number; generation: number }> {
    return this.sql
      .exec<{ name: string; due_at: number; payload: string | null; attempts: number; generation: number }>(
        "SELECT name, due_at, payload, attempts, generation FROM core_timers ORDER BY name",
      )
      .toArray();
  }

  /** How many `gated` handler runs have reached the gate. */
  gateReached(): number {
    return this.gateWaiting;
  }

  /** Lets every waiting (and future) `gated` handler run continue. */
  openGate(): void {
    this.gateOpen = true;
  }

  /** Fails while `meta.alarm_write_failures` is above zero, counting it down. */
  protected override writeAlarm(due: number | null): Promise<void> {
    const failures = Number(this.getMeta("alarm_write_failures") ?? "0");
    if (failures > 0) {
      this.setMeta("alarm_write_failures", String(failures - 1));
      return Promise.reject(new Error("alarm write failed"));
    }
    // With `meta.manual_alarms` set, the alarm is parked a day later so the runtime never fires it by
    // itself during the test; runDurableObjectAlarm still runs it on demand.
    if (due !== null && this.getMeta("manual_alarms") === "1") return super.writeAlarm(due + 86_400_000);
    return super.writeAlarm(due);
  }

  protected override alarmRetryDelayMs(): number {
    return 20;
  }

  /** Waits (polling real timers) until `meta.outbox_hang` is no longer "1", then succeeds. */
  private async hangUntilReleased(): Promise<void> {
    while (this.getMeta("outbox_hang") === "1") await new Promise((resolve) => setTimeout(resolve, 5));
  }

  metaValue(key: string): string | null {
    return this.getMeta(key);
  }

  alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Runs a drain directly (as the timer would). */
  drainNow(): Promise<number | null> {
    return this.outbox.drain(this.log);
  }

  outboxStats(): {
    pending: number;
    dead: number;
    maxAttempts: number;
    sendCalls: number;
    streamBackoff: number;
    lastSuccessAt: number | null;
    oldestPendingAgeMs: number | null;
  } {
    const { pending, dead, maxAttempts, streamBackoff, lastSuccessAt, oldestPendingAgeMs } = this.outbox.stats();
    return { pending, dead, maxAttempts, sendCalls: this.sendCalls, streamBackoff, lastSuccessAt, oldestPendingAgeMs };
  }

  lastDrain(): { sends: number; sentRows: number; failedRows: number; deadRows: number; stoppedEarly: boolean } | null {
    return this.outbox.lastDrain;
  }

  /** Every pending row's id, attempts and retry time. */
  outboxRows(): Array<{ id: string; attempts: number; next_attempt_at: number; first_failed_at: number | null }> {
    return this.sql
      .exec<{ body: string; attempts: number; next_attempt_at: number; first_failed_at: number | null }>(
        "SELECT body, attempts, next_attempt_at, first_failed_at FROM core_outbox ORDER BY id",
      )
      .toArray()
      .map((r) => ({
        id: (JSON.parse(r.body) as { id: string }).id,
        attempts: r.attempts,
        next_attempt_at: r.next_attempt_at,
        first_failed_at: r.first_failed_at,
      }));
  }

  /** Adds rows whose ids are given; ids starting with "p" are poison. One transaction. */
  addRows(ids: string[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) this.outbox.enqueue({ type: "test.item", id, poison: id.startsWith("p") });
    });
  }

  cancel(name: string): void {
    this.cancelTimer(name);
  }

  timerLog(): string[] {
    return this.sql
      .exec<{ name: string }>("SELECT name FROM timer_log ORDER BY seq")
      .toArray()
      .map((r) => r.name);
  }

  sentBodies(): Array<{ batch: number; id: string; bytes: number }> {
    return this.sql
      .exec<{ batch: number; body: string }>("SELECT batch, body FROM sent ORDER BY seq")
      .toArray()
      .map((row) => {
        const body = JSON.parse(row.body) as { id: string };
        return { batch: row.batch, id: body.id, bytes: row.body.length };
      });
  }

  /**
   * Simulates time passing: moves every timer and outbox row `ms` earlier. The alarm stays where it
   * was, and `runDurableObjectAlarm` runs it straight away. (Past-due alarms would fire on their own
   * in the background and race the test.)
   */
  rewind(ms: number): void {
    this.sql.exec("UPDATE core_timers SET due_at = due_at - ?", ms);
    this.sql.exec("UPDATE core_outbox SET next_attempt_at = next_attempt_at - ?", ms);
  }

  /**
   * Moves time forward to the outbox drain timer (by moving rows and timers earlier), as if the
   * runtime had waited for it. Unlike a fixed rewind, rows further back stay further back.
   */
  advanceToNextRetry(): void {
    const next = this.sql
      .exec<{ next: number | null }>("SELECT MIN(due_at) AS next FROM core_timers WHERE name LIKE 'outbox:%'")
      .toArray()[0]?.next;
    const gap = next == null ? 0 : next - Date.now();
    if (gap > 0) this.rewind(gap + 1);
  }

  /** Reads schema state without the readiness guard. */
  rawState(): { schemaVersion: string | null; columns: string[]; rows: number } {
    const columns = this.sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('items')")
      .toArray()
      .map((c) => c.name);
    const rows = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM items").toArray()[0]?.n ?? 0;
    return { schemaVersion: this.getMeta("schema_version"), columns, rows };
  }

  meta(key: string, value: string): void {
    this.setMeta(key, value);
  }

  protected override onFetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("ok");
    const userId = new URL(request.url).searchParams.get("user") ?? "anon";
    return this.acceptSocket(socketAttachmentSchema, { userId, role: "member" }, ["room"]);
  }

  connected(): string[] {
    return this.sockets(socketAttachmentSchema, "room").map(([, a]) => a.userId);
  }

  protected override onSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const users = this.sockets(socketAttachmentSchema).map(([, a]) => a.userId);
    ws.send(JSON.stringify({ type: "test.echo", message: typeof message === "string" ? message : "[binary]", users }));
  }
}
