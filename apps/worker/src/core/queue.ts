import { defineMessageSet, type MessageSchema, type MessageSet } from "@officebox/shared";
import type { z } from "zod";
import type { Env } from "../env";
import type { CoreContext } from "./context";
import { rootLogger, type Logger } from "./log";

/**
 * Queue consumer framework.
 *
 * - Each queue has a **registry of typed handlers keyed by message `type`**. A handler declares its
 *   message schema with `defineMessage` (the shared envelope `{ type, id?, ...payload }`), so every
 *   message is validated before it reaches the handler (AGENTS §4.1).
 * - **Per-message ack and retry.** A handler returns `ack` (done), `retry` (try again later, with an
 *   optional delay) or `dead_letter` (can never succeed). A thrown error is a real failure and is
 *   retried with exponential backoff. After the queue's `max_retries` (wrangler.jsonc) the runtime
 *   moves the message to the queue's dead-letter queue.
 * - **Unknown or invalid messages go straight to the dead-letter queue** and are acked, so they are
 *   never retried forever. Only the message type, ID and reason are logged, never the body.
 * - Handlers must be **idempotent**: delivery is at least once.
 * - **Retries count towards `max_retries`.** A `retry` outcome and a thrown error each use one of
 *   the queue's retries; when they run out, the runtime moves the raw message to the queue's DLQ.
 *   `dead_letter` sends the message to the DLQ (wrapped, below) and acks it, using no retry, unless
 *   the DLQ send fails, in which case the message is retried and that retry counts.
 *
 * **Dead-letter payload.** Messages this framework dead-letters are wrapped as `DeadLetter`:
 * `{ original, reason, queue, attempts, firstSeenAt }`. `original` is the message body unchanged,
 * `reason` is `invalid_json | too_large | invalid_envelope | unknown_type | invalid_payload` or the
 * handler's own reason, and `firstSeenAt` is the message's enqueue time (epoch ms). Messages the
 * runtime dead-letters after `max_retries` arrive unwrapped. A re-drive tool unwraps `original`.
 *
 * DLQ depth is reported by admin health in M7 (TDD §7.1).
 */

export type HandlerOutcome =
  { kind: "ack" } | { kind: "retry"; delaySeconds?: number } | { kind: "dead_letter"; reason: string };

export const ACK: HandlerOutcome = { kind: "ack" };

export interface QueueMessageContext extends CoreContext {
  /** Delivery attempt, starting at 1. */
  attempts: number;
  messageId: string;
}

export interface QueueHandler<S extends MessageSchema = MessageSchema> {
  schema: S;
  handle(message: z.infer<S>, ctx: QueueMessageContext): Promise<HandlerOutcome | void>;
}

export function defineQueueHandler<S extends MessageSchema>(handler: QueueHandler<S>): QueueHandler<S> {
  return handler;
}

export interface QueueDefinition {
  /** The queue name in wrangler.jsonc, for example `officebox-email`. */
  queue: string;
  /** Producer binding for the queue's dead-letter queue. */
  deadLetter: (env: Env) => Queue;
  handlers: readonly QueueHandler[];
}

export interface QueueRegistry {
  queues: readonly QueueDefinition[];
}

const BASE_RETRY_SECONDS = 10;
const MAX_RETRY_SECONDS = 15 * 60;

/** Exponential retry delay for attempt `attempts` (1-based): 10 s, 20 s, 40 s, … capped at 15 minutes. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(BASE_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_SECONDS);
}

interface CompiledQueue {
  definition: QueueDefinition;
  handlers: Map<string, QueueHandler>;
  messages: MessageSet<{ type: string }>;
}

/** Builds the `queue()` export from a registry. */
export function createQueueConsumer(registry: QueueRegistry, log: Logger = rootLogger) {
  const compiled = new Map<string, CompiledQueue>();
  for (const definition of registry.queues) {
    if (compiled.has(definition.queue)) throw new Error(`Queue ${definition.queue} registered twice`);
    const handlers = new Map<string, QueueHandler>();
    for (const handler of definition.handlers) handlers.set(handler.schema.shape.type.value, handler);
    compiled.set(definition.queue, {
      definition,
      handlers,
      // Every schema comes from defineMessage, so each parsed message has a string `type`.
      messages: defineMessageSet(definition.handlers.map((h) => h.schema)) as MessageSet<{ type: string }>,
    });
  }

  return async function queue(batch: MessageBatch, env: Env, _ctx?: ExecutionContext): Promise<void> {
    const queueLog = log.child({ queue: batch.queue });
    const entry = compiled.get(batch.queue);
    if (!entry) {
      // No consumer code for this queue: retry so the runtime moves the messages to its DLQ.
      queueLog.error("no consumer registered for queue", { messages: batch.messages.length });
      batch.retryAll();
      return;
    }

    for (const message of batch.messages) {
      const msgLog = queueLog.child({ messageId: message.id, attempts: message.attempts });
      const parsed = entry.messages.parse(message.body);

      if (!parsed.ok) {
        msgLog.warn("refusing queue message; sending it to the dead-letter queue", {
          reason: parsed.error.reason,
          // Client-supplied, so cut short before logging.
          type: parsed.error.type?.slice(0, 64),
        });
        await deadLetter(entry, env, message, parsed.error.reason, msgLog);
        continue;
      }

      const type = parsed.value.type;
      const handler = entry.handlers.get(type);
      if (!handler) {
        // Unreachable: the message set and the handler map are built from the same list.
        await deadLetter(entry, env, message, "unknown_type", msgLog);
        continue;
      }

      const started = Date.now();
      try {
        const outcome =
          (await handler.handle(parsed.value, {
            env,
            log: msgLog.child({ type }),
            now: Date.now,
            attempts: message.attempts,
            messageId: message.id,
          })) ?? ACK;
        const durationMs = Date.now() - started;
        if (outcome.kind === "ack") {
          message.ack();
          msgLog.debug("queue message handled", { type, durationMs });
        } else if (outcome.kind === "retry") {
          message.retry({ delaySeconds: outcome.delaySeconds ?? retryDelaySeconds(message.attempts) });
          msgLog.info("queue message will be retried", { type, durationMs });
        } else {
          msgLog.warn("handler sent queue message to the dead-letter queue", { type, reason: outcome.reason });
          await deadLetter(entry, env, message, outcome.reason, msgLog);
        }
      } catch (error) {
        msgLog.error("queue handler failed; will retry", { type, error, durationMs: Date.now() - started });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  };
}

/** Body of a message this framework sends to a dead-letter queue. */
export interface DeadLetter {
  original: unknown;
  reason: string;
  queue: string;
  attempts: number;
  firstSeenAt: number;
}

async function deadLetter(
  entry: CompiledQueue,
  env: Env,
  message: Message,
  reason: string,
  log: Logger,
): Promise<void> {
  const body: DeadLetter = {
    original: message.body,
    reason,
    queue: entry.definition.queue,
    attempts: message.attempts,
    firstSeenAt: message.timestamp.getTime(),
  };
  try {
    await entry.definition.deadLetter(env).send(body, { contentType: "json" });
    message.ack();
  } catch (error) {
    // Couldn't reach the DLQ: retry, and the runtime's own DLQ handling takes over after max_retries.
    log.error("could not send to the dead-letter queue; retrying", { error });
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}
