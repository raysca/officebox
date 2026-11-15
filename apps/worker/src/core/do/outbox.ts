import type { Logger } from "../log";
import { backoffMs } from "./backoff";

/**
 * Transactional outbox for Durable Objects (TDD §3.3), generalised from the spike's ChatChannel.
 *
 * - **Same transaction.** `enqueue` is synchronous and writes a row to `core_outbox`; call it inside
 *   the `ctx.storage.transactionSync` that makes the state change, so the change and its outgoing
 *   message commit together or not at all.
 * - **Drained by a named alarm timer** (`outbox:<stream>`), set `batchDelayMs` after the first enqueue
 *   (250 ms by default) so several changes go out in one `sendBatch`. New rows are never held back.
 * - **Chunked by Queues limits:** at most 128 KB per message and 256 KB and 100 messages per
 *   `sendBatch`, with margins. A message over the per-message limit is a programming error (features
 *   cap their sizes before writing) and `enqueue` throws, aborting the transaction.
 * - **Rows are deleted only after their chunk is sent.** A failing chunk is split in halves and retried,
 *   down to single rows, so a bad row ("poison") can't hold back the others in the same drain.
 *
 * **Failures are per row.** Every row that was in a failed send during a drain, and wasn't sent later
 * in it, counts one attempt (`attempts + 1`) and backs off on its own: `next_attempt_at = MAX(existing,
 * now + backoff(attempts))` with up to 20 % jitter (2 s, 4 s, … capped at 5 minutes). A successful send
 * deletes the row. `attempts` drives backoff and ordering only; it never decides dead-lettering.
 *
 * **Order within a drain.** Due rows are taken by `attempts, id` (at most `DRAIN_ROWS`). A drain then
 * sends in two phases: first the rows that have failed before (the ride-along below, then the due
 * ones), then the fresh rows (attempts 0). The first phase is capped at half the send budget when
 * there are fresh rows, so fresh rows always get the other half and are never starved; their
 * successes come after the earlier failures and serve as proof that the queue was healthy. Failing
 * chunks are bisected right half first. Under a sustained backlog of more than `DRAIN_ROWS` fresh
 * rows per drain, rows that have failed before (apart from the ride-along) wait until it clears.
 *
 * **Ride-along.** When a drain has fresh rows and the stream is healthy (the previous drain delivered
 * something, so `outbox_failed_drains:<stream>` is absent), up to `RIDE_ALONG_ROWS` (4) rows that
 * have failed before are tested too, even if they aren't due yet. During an outage nothing rides
 * along, so rows that aren't due keep their backoff. those with the most strikes, then the most
 * attempts. So a lone bad row is tested whenever real traffic flows, and judged against it. They
 * count against the same 32-send budget (at most about 7 sends for 4 rows).
 *
 * **Dead-letter rule: strikes need proof of health after the failure **(default)**.** The stream
 * keeps a success sequence, `outbox_success_seq:<stream>`, incremented the moment each successful
 * send resolves. When a row fails on its own (after bisection), the sequence at that moment is
 * noted; at the end of the drain the row gains a strike only if
 * - a later send in the **same drain** succeeded (end sequence > the sequence at the failure), and
 * - its previous strike, if any, was at least `minStrikeGapMs` ago (10 minutes **(default)**).
 * Failures inside multi-row batches never add strikes. A row is moved to `core_outbox_dead` at 10
 * strikes **(default)**. So:
 * - a queue outage adds no strikes, and neither does a queue that goes down after a success: nothing
 *   succeeds after the failures;
 * - a queue that alternates between success and failure on every send **can still dead-letter a good
 *   row** after 10 strikes, which takes at least 90 minutes of it (10 strikes, 10 minutes apart);
 *   accepted **(default)**;
 * - a lone bad row is dead-lettered once ten drains, at least 10 minutes apart, have had other rows
 *   sent after it (it rides along with fresh traffic); with no other traffic it is never
 *   dead-lettered and keeps retrying with backoff;
 * - rows written before strikes existed start at 0 strikes.
 * Dead rows are logged at error level and counted in `stats()`. Nothing reads or re-drives them
 * until M7.
 *
 * **Per-drain budget.** A drain makes at most `maxSendsPerDrain` sends (32 by default) and runs for at
 * most `maxDrainMs` (4 minutes, under the 5-minute outbox timer timeout); each send is limited to
 * `SEND_TIMEOUT_MS` (a timeout counts as a failure, and the message may still arrive). When a limit is
 * hit the drain stops and untried rows keep their retry time. If a drain sent nothing at all, the
 * untried due rows are pushed back by a stream backoff (`outbox_failed_drains:<stream>`, the count of
 * consecutive drains that sent nothing), without counting attempts, so a down queue isn't re-drained
 * in a tight loop; the count resets on the next success, and from 10 it logs at error level (the
 * queue is down, or every row tried is failing).
 *
 * **One drain at a time.** A drain that starts while another is still running does nothing and asks
 * to be run again shortly.
 *
 * **Guarantees.** Delivery is at least once, in no guaranteed order: rows that failed before are sent
 * ahead of fresh ones in a drain, failing chunks are bisected, and rows retry on their own backoff.
 * Consumers must be idempotent and order-tolerant (TDD §3.3: full state plus a version guard).
 *
 * **Logging.** While failures persist, the per-drain warning is written at most once every 5 minutes
 * per stream (with a count of the drains it stands for); the first error-level line, at 10 drains
 * that sent nothing, is always written.
 *
 * `meta` keys used: `outbox_success_seq:<stream>` (successful sends so far), `outbox_last_success_at:
 * <stream>` (epoch ms of the last one, for `stats()` only) and `outbox_failed_drains:<stream>`
 * (consecutive drains that sent nothing; absent after a success).
 */

/** Queues limit 128 KiB per message; keep a margin for the envelope. */
export const MAX_OUTBOX_MESSAGE_BYTES = 128_000;
/** Queues limit 256 KiB per `sendBatch`; keep a margin for per-message overhead. */
export const MAX_OUTBOX_BATCH_BYTES = 240_000;
/** Queues limit 100 messages per `sendBatch`. This also keeps the `DELETE … IN (…)` under 100 parameters. */
export const MAX_OUTBOX_BATCH_MESSAGES = 100;
export const DEFAULT_OUTBOX_DELAY_MS = 250;
/** Strikes (failures followed by a success in the same drain) before a row is dead-lettered. */
export const MAX_OUTBOX_STRIKES = 10;
/** Least time between two strikes on the same row. */
export const DEFAULT_MIN_STRIKE_GAP_MS = 10 * 60_000;
/** Rows that have failed before, added to a drain with fresh rows even if not yet due. */
export const RIDE_ALONG_ROWS = 4;
/** Sends per drain, including bisection. */
export const DEFAULT_MAX_SENDS_PER_DRAIN = 32;
/** Wall-clock limit per drain; under the 5-minute outbox timer timeout. */
export const DEFAULT_MAX_DRAIN_MS = 4 * 60_000;
/** Longest wait for one `send`; then it counts as failed. */
export const SEND_TIMEOUT_MS = 30_000;
/** Consecutive drains that sent nothing before each further one logs at error level. */
export const FAILED_DRAINS_ERROR_THRESHOLD = 10;
/** Up to 20 % random extra on each backoff, so rows that failed together don't retry in lockstep. */
export const DEFAULT_JITTER = 0.2;
/** Least time between two failure log lines for one stream while failures persist. */
const FAILURE_LOG_INTERVAL_MS = 5 * 60_000;
/** Rows read per drain; more are picked up by the next run, scheduled straight away. */
const DRAIN_ROWS = 500;
/** When a drain is already running, the overlapping run asks to be retried after this long. */
const BUSY_RETRY_MS = 5_000;

/** Sends one chunk. Throws on failure: the rows stay and are retried. */
export type OutboxSender = (bodies: unknown[]) => Promise<void>;

/** A setting given as a number, or as a function read when needed (tests vary them). */
type Tunable = number | (() => number);

export interface OutboxOptions {
  /** Stream name, normally the queue's purpose, for example `projection`. Lower case. */
  stream: string;
  send: OutboxSender;
  batchDelayMs?: number;
  /** Defaults to `SEND_TIMEOUT_MS`. */
  sendTimeoutMs?: Tunable;
  /** Defaults to `DEFAULT_MAX_SENDS_PER_DRAIN`. */
  maxSendsPerDrain?: Tunable;
  /** Defaults to `DEFAULT_MAX_DRAIN_MS`. */
  maxDrainMs?: Tunable;
  /** Random extra fraction added to each backoff; defaults to `DEFAULT_JITTER` (tests use 0). */
  jitter?: Tunable;
  /** Least time between strikes on one row; defaults to `DEFAULT_MIN_STRIKE_GAP_MS`. */
  minStrikeGapMs?: Tunable;
}

/** Sends JSON bodies to a queue with `sendBatch`. */
export function queueSender(queue: Queue): OutboxSender {
  return async (bodies) => {
    await queue.sendBatch(bodies.map((body) => ({ body, contentType: "json" as const })));
  };
}

const STREAM = /^[a-z][a-z0-9_]*$/;
const encoder = new TextEncoder();
const read = (value: Tunable): number => (typeof value === "function" ? value() : value);

type Row = {
  id: number;
  body: string;
  bytes: number;
  attempts: number;
  strikes: number;
  last_strike_at: number | null;
};

export interface OutboxStats {
  pending: number;
  /** Rows given up on (`core_outbox_dead`). */
  dead: number;
  /** Age of the oldest pending row in ms, or null when none is pending. */
  oldestPendingAgeMs: number | null;
  maxAttempts: number;
  /** Last successful send (epoch ms), or null. */
  lastSuccessAt: number | null;
  /** Successful sends so far (the strike sequence). */
  successSeq: number;
  maxStrikes: number;
  /** Consecutive drains that sent nothing (the stream backoff exponent); 0 after a success. */
  streamBackoff: number;
}

export interface DrainReport {
  /** `sendBatch` calls made. */
  sends: number;
  sentRows: number;
  failedRows: number;
  deadRows: number;
  /** Stopped by the send budget or the wall-clock limit. */
  stoppedEarly: boolean;
}

/** Per-drain bookkeeping. */
interface DrainState {
  sends: number;
  maxSends: number;
  deadline: number;
  stopped: boolean;
  sentRows: number;
  /** Rows of this drain not yet sent, in id order. */
  unsent: Map<number, Row>;
  /** Success sequence, kept in step with `meta` as sends succeed. */
  seq: number;
  /** Rows that failed when sent on their own, with the success sequence at that moment. */
  failedAlone: Map<number, number>;
  /** Rows that were in at least one failed send. */
  tried: Set<number>;
}

class SendTimeout extends Error {}

export class Outbox {
  readonly stream: string;
  private readonly send: OutboxSender;
  private readonly batchDelayMs: number;
  private readonly sendTimeoutMs: Tunable;
  private readonly maxSendsPerDrain: Tunable;
  private readonly maxDrainMs: Tunable;
  private readonly jitter: Tunable;
  private readonly minStrikeGapMs: Tunable;
  private draining = false;
  private lastFailureLogAt = -Infinity;
  private suppressedFailureLogs = 0;
  /** The last drain's report, for tests and diagnostics. */
  lastDrain: DrainReport | null = null;

  constructor(
    private readonly sql: SqlStorage,
    options: OutboxOptions,
    private readonly schedule: (dueAt: number) => void,
  ) {
    if (!STREAM.test(options.stream)) throw new Error(`Invalid outbox stream: ${options.stream}`);
    this.stream = options.stream;
    this.send = options.send;
    this.batchDelayMs = options.batchDelayMs ?? DEFAULT_OUTBOX_DELAY_MS;
    this.sendTimeoutMs = options.sendTimeoutMs ?? SEND_TIMEOUT_MS;
    this.maxSendsPerDrain = options.maxSendsPerDrain ?? DEFAULT_MAX_SENDS_PER_DRAIN;
    this.maxDrainMs = options.maxDrainMs ?? DEFAULT_MAX_DRAIN_MS;
    this.jitter = options.jitter ?? DEFAULT_JITTER;
    this.minStrikeGapMs = options.minStrikeGapMs ?? DEFAULT_MIN_STRIKE_GAP_MS;
  }

  /** Adds a message. Synchronous: call it inside the transaction that makes the state change. */
  enqueue(body: unknown): void {
    const json = JSON.stringify(body);
    if (json === undefined) throw new Error("Outbox message must be JSON-serialisable");
    const bytes = encoder.encode(json).byteLength;
    if (bytes > MAX_OUTBOX_MESSAGE_BYTES) {
      throw new Error(`Outbox message of ${bytes} bytes exceeds ${MAX_OUTBOX_MESSAGE_BYTES}`);
    }
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO core_outbox (stream, body, bytes, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, 0, ?, ?)",
      this.stream,
      json,
      bytes,
      now,
      now,
    );
    this.schedule(now + this.batchDelayMs);
  }

  private get lastSuccessKey(): string {
    return `outbox_last_success_at:${this.stream}`;
  }

  private get successSeqKey(): string {
    return `outbox_success_seq:${this.stream}`;
  }

  private get failedDrainsKey(): string {
    return `outbox_failed_drains:${this.stream}`;
  }

  private getMeta(key: string): string | null {
    const row = this.sql.exec<{ value: string | null }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  stats(): OutboxStats {
    const row = this.sql
      .exec<{
        pending: number;
        oldest: number | null;
        attempts: number | null;
        strikes: number | null;
      }>(
        `SELECT COUNT(*) AS pending, MIN(created_at) AS oldest, MAX(attempts) AS attempts, MAX(strikes) AS strikes
         FROM core_outbox WHERE stream = ?`,
        this.stream,
      )
      .toArray()[0];
    const dead =
      this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM core_outbox_dead WHERE stream = ?", this.stream)
        .toArray()[0]?.n ?? 0;
    const lastSuccess = this.getMeta(this.lastSuccessKey);
    return {
      pending: row?.pending ?? 0,
      dead,
      oldestPendingAgeMs: row?.oldest == null ? null : Math.max(0, Date.now() - row.oldest),
      maxAttempts: row?.attempts ?? 0,
      lastSuccessAt: lastSuccess === null ? null : Number(lastSuccess),
      successSeq: Number(this.getMeta(this.successSeqKey) ?? "0"),
      maxStrikes: row?.strikes ?? 0,
      streamBackoff: Number(this.getMeta(this.failedDrainsKey) ?? "0"),
    };
  }

  /**
   * Sends due rows in chunks. Returns when the next run is needed (epoch ms), or null when the stream
   * is empty. Never throws for a send failure.
   */
  async drain(log: Logger): Promise<number | null> {
    if (this.draining) {
      log.warn("outbox drain already running; skipping this run", { stream: this.stream });
      return Date.now() + BUSY_RETRY_MS;
    }
    this.draining = true;
    try {
      return await this.drainOnce(log);
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(log: Logger): Promise<number | null> {
    const startedAt = Date.now();
    const rows = this.sql
      .exec<Row>(
        `SELECT id, body, bytes, attempts, strikes, last_strike_at FROM core_outbox
         WHERE stream = ? AND next_attempt_at <= ? ORDER BY attempts, id LIMIT ?`,
        this.stream,
        startedAt,
        DRAIN_ROWS,
      )
      .toArray();
    let rideAlong: Row[] = [];
    // Only while the stream is healthy: during an outage, rows that aren't due keep their backoff.
    const healthy = this.getMeta(this.failedDrainsKey) === null;
    if (healthy && rows.some((row) => row.attempts === 0)) {
      // Ride-along: test a few rows that failed before against this fresh traffic.
      rideAlong = this.sql
        .exec<Row>(
          `SELECT id, body, bytes, attempts, strikes, last_strike_at FROM core_outbox
             WHERE stream = ? AND next_attempt_at > ? AND (strikes > 0 OR attempts > 0)
             ORDER BY strikes DESC, attempts DESC, id LIMIT ?`,
          this.stream,
          startedAt,
          RIDE_ALONG_ROWS,
        )
        .toArray();
    }

    const state: DrainState = {
      sends: 0,
      maxSends: read(this.maxSendsPerDrain),
      deadline: startedAt + read(this.maxDrainMs),
      stopped: false,
      sentRows: 0,
      unsent: new Map([...rideAlong, ...rows].map((row) => [row.id, row])),
      seq: Number(this.getMeta(this.successSeqKey) ?? "0"),
      failedAlone: new Map(),
      tried: new Set(),
    };
    // Phase 1: rows that failed before (ride-along, then due ones), so any success in phase 2 comes
    // after their failures. Capped at half the budget when there are fresh rows, so those always get
    // the other half. Phase 2: the fresh rows.
    const fresh = rows.filter((row) => row.attempts === 0);
    const suspects = [...rideAlong, ...rows.filter((row) => row.attempts > 0)];
    const budget = state.maxSends;
    state.maxSends = fresh.length > 0 ? Math.floor(budget / 2) : budget;
    for (const chunk of chunkRows(suspects)) {
      if (state.stopped) break;
      await this.sendChunk(chunk, state);
    }
    state.maxSends = budget;
    state.stopped = Date.now() >= state.deadline;
    for (const chunk of chunkRows(fresh)) {
      if (state.stopped) break;
      await this.sendChunk(chunk, state);
    }

    const now = Date.now();
    const endSeq = state.seq;
    const minGap = read(this.minStrikeGapMs);
    let deadRows = 0;
    let failedRows = 0;
    if (state.sentRows > 0) this.sql.exec("DELETE FROM meta WHERE key = ?", this.failedDrainsKey);

    for (const id of state.tried) {
      const row = state.unsent.get(id);
      if (!row) continue; // sent later in this drain
      failedRows += 1;
      const attempts = row.attempts + 1;
      if (!state.failedAlone.has(id)) {
        // Only ever in failed batches: an attempt (for backoff and ordering) but no strike, since the
        // failure may have been another row's.
        this.sql.exec(
          "UPDATE core_outbox SET attempts = ?, next_attempt_at = MAX(next_attempt_at, ?) WHERE id = ?",
          attempts,
          now + this.jittered(backoffMs(attempts)),
          row.id,
        );
        continue;
      }
      const seqAtFailure = state.failedAlone.get(id) ?? endSeq;
      let strikes = row.strikes;
      let lastStrikeAt = row.last_strike_at;
      // A strike needs a later success in this drain (proof the queue was healthy after the
      // failure), and a gap since the row's previous strike.
      const provenHealthy = endSeq > seqAtFailure;
      const gapPassed = lastStrikeAt === null || now - lastStrikeAt >= minGap;
      if (provenHealthy && gapPassed) {
        strikes += 1;
        lastStrikeAt = now;
      }
      if (strikes >= MAX_OUTBOX_STRIKES) {
        this.sql.exec(
          `INSERT INTO core_outbox_dead (id, stream, body, bytes, attempts, created_at, dead_at)
           SELECT id, stream, body, bytes, ?, created_at, ? FROM core_outbox WHERE id = ?`,
          attempts,
          now,
          row.id,
        );
        this.sql.exec("DELETE FROM core_outbox WHERE id = ?", row.id);
        deadRows += 1;
        log.error("outbox row can't be sent; moved to core_outbox_dead", {
          stream: this.stream,
          row: row.id,
          attempts,
          strikes,
        });
        continue;
      }
      this.sql.exec(
        `UPDATE core_outbox SET attempts = ?, strikes = ?, last_strike_at = ?, next_attempt_at = MAX(next_attempt_at, ?)
         WHERE id = ?`,
        attempts,
        strikes,
        lastStrikeAt,
        now + this.jittered(backoffMs(attempts)),
        row.id,
      );
    }

    if (state.sentRows === 0 && rows.length > 0) {
      // Nothing went out: push back the rows this drain didn't get to, without counting attempts,
      // so a down queue isn't re-drained in a tight loop.
      const failedDrains = Number(this.getMeta(this.failedDrainsKey) ?? "0") + 1;
      this.setMeta(this.failedDrainsKey, String(failedDrains));
      const retryAt = now + this.jittered(backoffMs(failedDrains));
      for (const [id] of state.unsent) {
        if (state.tried.has(id)) continue;
        this.sql.exec("UPDATE core_outbox SET next_attempt_at = MAX(next_attempt_at, ?) WHERE id = ?", retryAt, id);
      }
      const fields = { stream: this.stream, failedDrains, failedRows, sends: state.sends };
      if (failedDrains === FAILED_DRAINS_ERROR_THRESHOLD) {
        log.error(`no send succeeded in ${failedDrains} drains: queue outage or all rows failing`, fields);
        this.lastFailureLogAt = now;
        this.suppressedFailureLogs = 0;
      } else {
        this.logFailure(log, failedDrains >= FAILED_DRAINS_ERROR_THRESHOLD ? "error" : "warn", now, fields);
      }
    } else if (deadRows > 0) {
      log.warn("outbox rows failed; will retry", { stream: this.stream, failedRows, deadRows });
    } else if (failedRows > 0) {
      this.logFailure(log, "warn", now, { stream: this.stream, failedRows, deadRows });
    }

    this.lastDrain = {
      sends: state.sends,
      sentRows: state.sentRows,
      failedRows,
      deadRows,
      stoppedEarly: state.stopped,
    };
    const next = this.sql
      .exec<{ next: number | null }>(
        "SELECT MIN(next_attempt_at) AS next FROM core_outbox WHERE stream = ?",
        this.stream,
      )
      .toArray()[0];
    return next?.next ?? null;
  }

  /** Sends `rows`; on failure, bisects to isolate the rows that can't be sent, within the budget. */
  private async sendChunk(rows: Row[], state: DrainState): Promise<void> {
    if (rows.length === 0 || state.stopped) return;
    if (state.sends >= state.maxSends || Date.now() >= state.deadline) {
      state.stopped = true;
      return;
    }
    state.sends += 1;
    if (await this.trySend(rows)) {
      for (const row of rows) state.unsent.delete(row.id);
      state.sentRows += rows.length;
      // Advance the success sequence now, so failures later in this drain are ordered after it.
      state.seq += 1;
      this.setMeta(this.successSeqKey, String(state.seq));
      this.setMeta(this.lastSuccessKey, String(Date.now()));
      return;
    }
    for (const row of rows) state.tried.add(row.id);
    if (rows.length === 1 && rows[0]) {
      state.failedAlone.set(rows[0].id, state.seq);
      return;
    }
    const middle = Math.ceil(rows.length / 2);
    // Right half first, so rows that failed before (at the end) are tested before fresh ones.
    await this.sendChunk(rows.slice(middle), state);
    await this.sendChunk(rows.slice(0, middle), state);
  }

  /** Writes a failure line at most once per `FAILURE_LOG_INTERVAL_MS`, counting the ones skipped. */
  private logFailure(log: Logger, level: "warn" | "error", now: number, fields: Record<string, unknown>): void {
    if (now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) {
      this.suppressedFailureLogs += 1;
      return;
    }
    const message =
      level === "error"
        ? `no send succeeded in ${String(fields.failedDrains)} drains: queue outage or all rows failing`
        : "outbox send failures; backing off";
    log[level](message, { ...fields, suppressedSinceLastLog: this.suppressedFailureLogs });
    this.lastFailureLogAt = now;
    this.suppressedFailureLogs = 0;
  }

  /** Adds random jitter (up to the configured fraction) to a backoff. */
  private jittered(ms: number): number {
    return Math.round(ms * (1 + Math.random() * read(this.jitter)));
  }

  private async trySend(rows: Row[]): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.send(rows.map((row) => JSON.parse(row.body) as unknown)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SendTimeout()), read(this.sendTimeoutMs));
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
    // Chunks are at most 100 rows, so this stays within the bound-parameter limit.
    const ids = rows.map((row) => row.id);
    this.sql.exec(`DELETE FROM core_outbox WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
    return true;
  }
}

/** Splits rows, in order, into chunks within the per-batch byte and message limits. */
export function chunkRows<R extends Pick<Row, "bytes">>(rows: R[]): R[][] {
  const chunks: R[][] = [];
  let current: R[] = [];
  let size = 0;
  for (const row of rows) {
    if (
      current.length > 0 &&
      (current.length >= MAX_OUTBOX_BATCH_MESSAGES || size + row.bytes > MAX_OUTBOX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += row.bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
