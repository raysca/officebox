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
 *   retried, down to single rows, so one bad row ("poison") can't hold back the others. Two single
 *   rows failing in a row, with nothing sent in between, means the queue itself is down (at any point
 *   in the drain): the drain stops after about log₂(chunk) + 2 calls. Only rows actually tried get an
 *   attempt, with exponential backoff (2 s, 4 s, … capped at 5 minutes); the untried rows wait out
 *   the same backoff, and while the outage lasts new messages don't pull the drain earlier.
 * - **One drain at a time.** Each send is limited to `SEND_TIMEOUT_MS` (a timeout counts as a
 *   failure, and the message may still arrive: at least once). A drain that starts while another is
 *   still running does nothing and asks to be run again shortly.
 * - **Dead rows.** A row that has failed `MAX_OUTBOX_ATTEMPTS` times **(default 10)** while other rows
 *   were being sent successfully and no outage was detected is moved to `core_outbox_dead`, logged at
 *   error level and counted in `stats()`. Nothing reads or re-drives that table until M7. Failures during an outage never kill a row. A row alone in its
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
/** Longest wait for one `send`; then it counts as failed. */
export const SEND_TIMEOUT_MS = 30_000;
/** When a drain is already running, the overlapping run asks to be retried after this long. */
const BUSY_RETRY_MS = 5_000;

/** Sends one chunk. Throws on failure: the rows stay and are retried. */
export type OutboxSender = (bodies: unknown[]) => Promise<void>;

export interface OutboxOptions {
  /** Stream name, normally the queue's purpose, for example `projection`. Lower case. */
  stream: string;
  send: OutboxSender;
  batchDelayMs?: number;
  /** Defaults to `SEND_TIMEOUT_MS`. */
  sendTimeoutMs?: number;
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
  /** Single-row sends that failed since the last successful send. */
  singleFailuresInRow: number;
}

class SendTimeout extends Error {}

export class Outbox {
  readonly stream: string;
  private readonly send: OutboxSender;
  private readonly batchDelayMs: number;
  private readonly sendTimeoutMs: number;
  private draining = false;

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
    // During an outage, new messages wait for the next retry instead of probing the queue each time.
    const notBefore = Math.max(now, this.outageUntil() ?? 0);
    this.sql.exec(
      "INSERT INTO core_outbox (stream, body, bytes, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, 0, ?, ?)",
      this.stream,
      json,
      bytes,
      notBefore,
      now,
    );
    this.schedule(Math.max(now + this.batchDelayMs, notBefore));
  }

  private get outageKey(): string {
    return `outbox_outage_until:${this.stream}`;
  }

  /** When the queue is next tried after a detected outage, or null. */
  private outageUntil(): number | null {
    const row = this.sql
      .exec<{ value: string | null }>("SELECT value FROM meta WHERE key = ?", this.outageKey)
      .toArray()[0];
    return row?.value ? Number(row.value) : null;
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

    const state: DrainState = { sentAny: false, failed: [], outage: false, singleFailuresInRow: 0 };
    const chunks = chunkRows(rows);
    for (let i = 0; i < chunks.length && !state.outage; i++) {
      await this.sendChunk(chunks[i] ?? [], state);
    }
    const lastId = rows[rows.length - 1]?.id;
    if (state.outage && lastId !== undefined) {
      // The rest of this drain's rows wait out the same backoff, without an attempt counted against them.
      const attempts = Math.max(...state.failed.map((row) => row.attempts)) + 1;
      const retryAt = Date.now() + backoffMs(attempts);
      this.sql.exec(
        "UPDATE core_outbox SET next_attempt_at = ? WHERE stream = ? AND id <= ?",
        retryAt,
        this.stream,
        lastId,
      );
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        this.outageKey,
        String(retryAt),
      );
    } else if (state.sentAny) {
      this.sql.exec("DELETE FROM meta WHERE key = ?", this.outageKey);
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

  /**
   * Sends `rows`; on failure, bisects to isolate the rows that can't be sent. Stops (outage) when two
   * single rows fail in a row with no successful send between them.
   */
  private async sendChunk(rows: Row[], state: DrainState): Promise<void> {
    if (rows.length === 0 || state.outage) return;
    if (await this.trySend(rows)) {
      state.sentAny = true;
      state.singleFailuresInRow = 0;
      return;
    }
    if (rows.length === 1) {
      state.failed.push(...rows);
      state.singleFailuresInRow += 1;
      if (state.singleFailuresInRow >= 2) state.outage = true;
      return;
    }
    const middle = Math.ceil(rows.length / 2);
    await this.sendChunk(rows.slice(0, middle), state);
    await this.sendChunk(rows.slice(middle), state);
  }

  private async trySend(rows: Row[]): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.send(rows.map((row) => JSON.parse(row.body) as unknown)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SendTimeout()), this.sendTimeoutMs);
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

  private recordFailures(state: DrainState, log: Logger): void {
    if (state.failed.length === 0) return;
    const now = Date.now();
    // A failure only counts towards giving up when the queue accepted other rows in the same drain
    // and no outage was detected.
    const isolated = state.sentAny && !state.outage;
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
