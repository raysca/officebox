import type { Logger } from "../log";
import { backoffMs } from "./backoff";

/**
 * Transactional outbox for Durable Objects (TDD §3.3), generalised from the spike's ChatChannel.
 *
 * - **Same transaction.** `enqueue` is synchronous and writes a row to `core_outbox`; call it inside
 *   the `ctx.storage.transactionSync` that makes the state change, so the change and its outgoing
 *   message commit together or not at all.
 * - **Drained by a named alarm timer** (`outbox:<stream>`), set `batchDelayMs` after the first enqueue
 *   (250 ms by default) so several changes go out in one `sendBatch`.
 * - **Chunked by Queues limits:** at most 128 KB per message and 256 KB and 100 messages per
 *   `sendBatch`, with margins. A message over the per-message limit is a programming error (features
 *   cap their sizes before writing) and `enqueue` throws, aborting the transaction.
 * - **Rows are deleted only after their chunk is sent.** When a chunk fails, it is split in halves and
 *   retried, down to single rows, so one bad row ("poison") can't hold back the others. If both halves
 *   of a chunk fail before anything has been sent in this drain, the queue itself is taken to be down
 *   and the drain stops. Only rows actually tried get an attempt, with exponential backoff (2 s, 4 s,
 *   … capped at 5 minutes).
 * - **Dead rows.** A row that has failed `MAX_OUTBOX_ATTEMPTS` times **(default 10)** while other rows
 *   were being sent successfully (so the queue was up) is moved to `core_outbox_dead`, logged at error
 *   level and counted in `stats()`. Failures during an outage never kill a row. A row alone in its
 *   stream can't be told apart from an outage, so it keeps retrying until another row succeeds.
 *
 * Delivery is at least once and normally in order; after a failure, newer rows may overtake older
 * ones being retried. Consumers must be idempotent and order-tolerant (TDD §3.3: full state plus a
 * version guard).
 */

/** Queues limit 128 KiB per message; keep a margin for the envelope. */
export const MAX_OUTBOX_MESSAGE_BYTES = 128_000;
/** Queues limit 256 KiB per `sendBatch`; keep a margin for per-message overhead. */
export const MAX_OUTBOX_BATCH_BYTES = 240_000;
/** Queues limit 100 messages per `sendBatch`. This also keeps the `DELETE … IN (…)` under 100 parameters. */
export const MAX_OUTBOX_BATCH_MESSAGES = 100;
export const DEFAULT_OUTBOX_DELAY_MS = 250;
/** Failed sends, with the queue otherwise working, before a row is moved to `core_outbox_dead`. */
export const MAX_OUTBOX_ATTEMPTS = 10;
/** Rows read per drain; more are picked up by the next run, scheduled straight away. */
const DRAIN_ROWS = 500;

/** Sends one chunk. Throws on failure: the rows stay and are retried. */
export type OutboxSender = (bodies: unknown[]) => Promise<void>;

export interface OutboxOptions {
  /** Stream name, normally the queue's purpose, for example `projection`. Lower case. */
  stream: string;
  send: OutboxSender;
  batchDelayMs?: number;
}

/** Sends JSON bodies to a queue with `sendBatch`. */
export function queueSender(queue: Queue): OutboxSender {
  return async (bodies) => {
    await queue.sendBatch(bodies.map((body) => ({ body, contentType: "json" as const })));
  };
}

const STREAM = /^[a-z][a-z0-9_]*$/;
const encoder = new TextEncoder();

interface Row {
  id: number;
  body: string;
  bytes: number;
  attempts: number;
}

export interface OutboxStats {
  pending: number;
  oldestCreatedAt: number | null;
  maxAttempts: number;
  /** Rows given up on (`core_outbox_dead`). */
  dead: number;
}

/** Per-drain bookkeeping. */
interface DrainState {
  sentAny: boolean;
  failed: Row[];
  outage: boolean;
}

export class Outbox {
  readonly stream: string;
  private readonly send: OutboxSender;
  private readonly batchDelayMs: number;

  constructor(
    private readonly sql: SqlStorage,
    options: OutboxOptions,
    private readonly schedule: (dueAt: number) => void,
  ) {
    if (!STREAM.test(options.stream)) throw new Error(`Invalid outbox stream: ${options.stream}`);
    this.stream = options.stream;
    this.send = options.send;
    this.batchDelayMs = options.batchDelayMs ?? DEFAULT_OUTBOX_DELAY_MS;
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

  stats(): OutboxStats {
    const row = this.sql
      .exec<{
        pending: number;
        oldest: number | null;
        attempts: number | null;
      }>(
        "SELECT COUNT(*) AS pending, MIN(created_at) AS oldest, MAX(attempts) AS attempts FROM core_outbox WHERE stream = ?",
        this.stream,
      )
      .toArray()[0];
    const dead =
      this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM core_outbox_dead WHERE stream = ?", this.stream)
        .toArray()[0]?.n ?? 0;
    return { pending: row?.pending ?? 0, oldestCreatedAt: row?.oldest ?? null, maxAttempts: row?.attempts ?? 0, dead };
  }

  /**
   * Sends due rows in chunks. Returns when the next run is needed (epoch ms), or null when the stream
   * is empty. Never throws for a send failure.
   */
  async drain(log: Logger): Promise<number | null> {
    const rows = this.sql
      .exec<{
        id: number;
        body: string;
        bytes: number;
        attempts: number;
      }>(
        "SELECT id, body, bytes, attempts FROM core_outbox WHERE stream = ? AND next_attempt_at <= ? ORDER BY id LIMIT ?",
        this.stream,
        Date.now(),
        DRAIN_ROWS,
      )
      .toArray();

    const state: DrainState = { sentAny: false, failed: [], outage: false };
    const chunks = chunkRows(rows);
    for (let i = 0; i < chunks.length && !state.outage; i++) {
      await this.sendChunk(chunks[i] ?? [], state);
    }
    const lastId = rows[rows.length - 1]?.id;
    if (state.outage && lastId !== undefined) {
      // The rest of this drain's rows wait out the same backoff, without an attempt counted against them.
      const attempts = Math.max(...state.failed.map((row) => row.attempts)) + 1;
      this.sql.exec(
        "UPDATE core_outbox SET next_attempt_at = ? WHERE stream = ? AND id <= ?",
        Date.now() + backoffMs(attempts),
        this.stream,
        lastId,
      );
    }
    this.recordFailures(state, log);

    const next = this.sql
      .exec<{ next: number | null }>(
        "SELECT MIN(next_attempt_at) AS next FROM core_outbox WHERE stream = ?",
        this.stream,
      )
      .toArray()[0];
    return next?.next ?? null;
  }

  /** Sends `rows`; on failure, bisects to isolate the rows that can't be sent. */
  private async sendChunk(rows: Row[], state: DrainState): Promise<void> {
    if (rows.length === 0) return;
    if (await this.trySend(rows)) {
      state.sentAny = true;
      return;
    }
    if (rows.length === 1) {
      state.failed.push(...rows);
      return;
    }
    const middle = Math.ceil(rows.length / 2);
    const left = rows.slice(0, middle);
    const right = rows.slice(middle);
    const sentBefore = state.sentAny;
    const failedBefore = state.failed.length;
    await this.sendChunk(left, state);
    if (state.outage) return;
    const leftFailedWhole = !state.sentAny && state.failed.length > failedBefore;
    if (!sentBefore && leftFailedWhole && !(await this.trySend(right))) {
      // Everything tried in this drain failed: treat it as a queue outage, not as bad rows.
      state.failed.push(...right);
      state.outage = true;
      return;
    }
    if (sentBefore || !leftFailedWhole) {
      await this.sendChunk(right, state);
    } else {
      // The right half was sent by the probe above.
      state.sentAny = true;
    }
  }

  private async trySend(rows: Row[]): Promise<boolean> {
    try {
      await this.send(rows.map((row) => JSON.parse(row.body) as unknown));
    } catch {
      return false;
    }
    // Chunks are at most 100 rows, so this stays within the bound-parameter limit.
    const ids = rows.map((row) => row.id);
    this.sql.exec(`DELETE FROM core_outbox WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
    return true;
  }

  private recordFailures(state: DrainState, log: Logger): void {
    if (state.failed.length === 0) return;
    const now = Date.now();
    // A failure only counts towards giving up when the queue accepted other rows in the same drain.
    const isolated = state.sentAny;
    let dead = 0;
    for (const row of state.failed) {
      const attempts = row.attempts + 1;
      if (isolated && attempts >= MAX_OUTBOX_ATTEMPTS) {
        this.sql.exec(
          `INSERT INTO core_outbox_dead (id, stream, body, bytes, attempts, created_at, dead_at)
           SELECT id, stream, body, bytes, ?, created_at, ? FROM core_outbox WHERE id = ?`,
          attempts,
          now,
          row.id,
        );
        this.sql.exec("DELETE FROM core_outbox WHERE id = ?", row.id);
        dead += 1;
        log.error("outbox row can't be sent; moved to core_outbox_dead", {
          stream: this.stream,
          row: row.id,
          attempts,
        });
        continue;
      }
      this.sql.exec(
        "UPDATE core_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?",
        attempts,
        now + backoffMs(attempts),
        row.id,
      );
    }
    log.warn("outbox send failed; will retry", {
      stream: this.stream,
      failed: state.failed.length - dead,
      dead,
      outage: !isolated,
    });
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
