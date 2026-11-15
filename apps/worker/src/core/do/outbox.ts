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
 * - **Rows are deleted only after their chunk is sent.** On failure the unsent rows get exponential
 *   backoff (2 s, 4 s, … capped at 5 minutes) and are retried until delivered.
 *
 * Delivery is at least once and normally in order; after a failure, newer rows may overtake older
 * ones being retried. Consumers must be idempotent and order-tolerant (TDD §3.3: full state plus a
 * version guard).
 */

/** Queues limit 128 KiB per message; keep a margin for the envelope. */
export const MAX_OUTBOX_MESSAGE_BYTES = 128_000;
/** Queues limit 256 KiB per `sendBatch`; keep a margin for per-message overhead. */
export const MAX_OUTBOX_BATCH_BYTES = 240_000;
/** Queues limit 100 messages per `sendBatch`. */
export const MAX_OUTBOX_BATCH_MESSAGES = 100;
export const DEFAULT_OUTBOX_DELAY_MS = 250;
/** Rows read per drain; more are picked up by the next run, scheduled straight away. */
const DRAIN_ROWS = 500;

/** Sends one chunk. Throws on failure (the queue is unavailable): the rows stay and are retried. */
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
    return { pending: row?.pending ?? 0, oldestCreatedAt: row?.oldest ?? null, maxAttempts: row?.attempts ?? 0 };
  }

  /**
   * Sends due rows in chunks. Returns when the next run is needed (epoch ms), or null when the stream
   * is empty. Never throws for a send failure.
   */
  async drain(log: Logger): Promise<number | null> {
    const now = Date.now();
    const rows = this.sql
      .exec<{
        id: number;
        body: string;
        bytes: number;
        attempts: number;
      }>(
        "SELECT id, body, bytes, attempts FROM core_outbox WHERE stream = ? AND next_attempt_at <= ? ORDER BY id LIMIT ?",
        this.stream,
        now,
        DRAIN_ROWS,
      )
      .toArray();

    const chunks = chunkRows(rows);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] ?? [];
      try {
        await this.send(chunk.map((row) => JSON.parse(row.body) as unknown));
      } catch (error) {
        // Keep this chunk and every later one (preserving their order) for a retry with backoff.
        const unsent = chunks.slice(i).flat();
        const retryAt = Date.now();
        for (const row of unsent) {
          const attempts = row.attempts + 1;
          this.sql.exec(
            "UPDATE core_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?",
            attempts,
            retryAt + backoffMs(attempts),
            row.id,
          );
        }
        log.warn("outbox send failed; will retry", { stream: this.stream, unsent: unsent.length, error });
        break;
      }
      const ids = chunk.map((row) => row.id);
      this.sql.exec(`DELETE FROM core_outbox WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
    }

    const next = this.sql
      .exec<{ next: number | null }>(
        "SELECT MIN(next_attempt_at) AS next FROM core_outbox WHERE stream = ?",
        this.stream,
      )
      .toArray()[0];
    return next?.next ?? null;
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
