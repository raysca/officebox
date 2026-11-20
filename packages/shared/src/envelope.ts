import { z } from "zod";
import { apiError, apiErrorSchema, validationError, type ApiError } from "./errors";
import { err, ok, type Result } from "./result";

/**
 * Message envelope `{ type, id?, ...payload }`, used for WebSocket messages in both directions and for
 * queue messages between the Worker and its consumers.
 *
 * - `type` names the message, namespaced by feature with a dot (for example `chat.send`).
 * - `id` is optional and set by the sender when it wants a reply correlated with the request.
 * - Every other field is the payload, flat on the same object.
 *
 * `envelopeSchema` validates only the envelope, so a router can read `type` and dispatch to the
 * message's own schema. Concrete messages are declared with `defineMessage`, which rejects unknown
 * fields, and grouped with `defineMessageSet`, which parses raw input into the union of its messages.
 * Every WebSocket and queue message is validated against its concrete schema (AGENTS §4.1).
 */

export const MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export const messageTypeSchema = z.string().min(1).max(64).regex(MESSAGE_TYPE_PATTERN);

export const messageIdSchema = z.string().min(1).max(64);

export const envelopeSchema = z.looseObject({
  type: messageTypeSchema,
  id: messageIdSchema.optional(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Keepalive frames. Sockets send the literal text `ping`; Durable Objects answer `pong` through
 * `setWebSocketAutoResponse` without waking (TDD §3.2). They are not JSON envelopes.
 */
export const WS_PING = "ping";
export const WS_PONG = "pong";

/** Declares a concrete message schema with a literal `type`, an optional `id` and a strict payload. */
export function defineMessage<const T extends string, S extends z.ZodRawShape>(type: T, payload: S) {
  if (!MESSAGE_TYPE_PATTERN.test(type)) {
    throw new Error(`Invalid message type: ${type}`);
  }
  return z.strictObject({
    type: z.literal(type),
    id: messageIdSchema.optional(),
    ...payload,
  });
}

/** A schema produced by `defineMessage`. */
export type MessageSchema = ReturnType<typeof defineMessage<string, z.ZodRawShape>>;

/** Sent by a server when a client message is refused: `{ type: "error", id?, error }`. */
export const errorMessageSchema = defineMessage("error", { error: apiErrorSchema });
export type ErrorMessage = z.infer<typeof errorMessageSchema>;

export function errorMessage(error: ApiError, id?: string): ErrorMessage {
  return id === undefined ? { type: "error", error } : { type: "error", id, error };
}

/** Why a raw message was refused. `unknown_type` lets a consumer treat unknown messages differently. */
export interface MessageParseError {
  reason: "invalid_json" | "too_large" | "invalid_envelope" | "unknown_type" | "invalid_payload";
  /** The envelope's `type` when it could be read. */
  type?: string;
  /** The envelope's `id` when it could be read, so a refusal can be correlated. */
  id?: string;
  error: ApiError;
}

export interface MessageSet<M> {
  readonly types: readonly string[];
  /** Parses an already-decoded value (for example a queue message body). */
  parse(input: unknown): Result<M, MessageParseError>;
  /** Decodes JSON text (for example a WebSocket frame) and parses it. */
  parseText(text: string, maxBytes?: number): Result<M, MessageParseError>;
}

/** Extracts the union message type `M` from a `MessageSet<M>`. */
export type MessageOf<S> = S extends MessageSet<infer M> ? M : never;

const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/**
 * Groups message schemas so raw input can be parsed into their discriminated union by `type`.
 * Duplicate types are a programming error and throw at definition time.
 */
export function defineMessageSet<const S extends readonly MessageSchema[]>(schemas: S): MessageSet<z.infer<S[number]>> {
  const byType = new Map<string, MessageSchema>();
  for (const schema of schemas) {
    const type = schema.shape.type.value;
    if (byType.has(type)) throw new Error(`Duplicate message type: ${type}`);
    byType.set(type, schema);
  }

  const parse = (input: unknown): Result<z.infer<S[number]>, MessageParseError> => {
    const envelope = envelopeSchema.safeParse(input);
    if (!envelope.success) {
      return err({ reason: "invalid_envelope", error: validationError(envelope.error, "The message is not valid.") });
    }
    const { type, id } = envelope.data;
    const schema = byType.get(type);
    if (!schema) {
      return err({ reason: "unknown_type", type, id, error: apiError("validation_failed", "Unknown message type.") });
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return err({
        reason: "invalid_payload",
        type,
        id,
        error: validationError(parsed.error, "The message is not valid."),
      });
    }
    return ok(parsed.data as z.infer<S[number]>);
  };

  return {
    types: [...byType.keys()],
    parse,
    parseText(text, maxBytes = DEFAULT_MAX_TEXT_BYTES) {
      if (text.length > maxBytes || encoder.encode(text).byteLength > maxBytes) {
        return err({ reason: "too_large", error: apiError("payload_too_large", "The message is too large.") });
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return err({ reason: "invalid_json", error: apiError("validation_failed", "The message is not valid JSON.") });
      }
      return parse(value);
    },
  };
}
