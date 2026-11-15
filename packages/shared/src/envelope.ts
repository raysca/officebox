import { z } from "zod";

/**
 * WebSocket message envelope: `{ type, id?, ...payload }`.
 *
 * - `type` names the message, namespaced by feature with a dot (for example `chat.send`).
 * - `id` is optional and set by the sender when it wants a reply correlated with the request.
 * - Every other field is the payload, flat on the same object.
 *
 * `envelopeSchema` validates only the envelope, so a router can read `type` and dispatch to the
 * message's own schema. Concrete messages are declared with `defineMessage`, which rejects unknown
 * fields. Every WebSocket message is validated against its concrete schema (AGENTS §4.1).
 */

export const MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export const messageTypeSchema = z.string().min(1).max(64).regex(MESSAGE_TYPE_PATTERN);

export const messageIdSchema = z.string().min(1).max(64);

export const envelopeSchema = z.looseObject({
  type: messageTypeSchema,
  id: messageIdSchema.optional(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

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
