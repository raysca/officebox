import type { z } from "zod";

/**
 * Typed WebSocket attachments for hibernating Durable Objects (TDD §3.1, §3.2).
 *
 * An attachment is the per-connection state that must survive hibernation (user ID, role, connection
 * ID). It is stored with the socket by the runtime, so it is read back after the object wakes. Values
 * are validated against a Zod schema on the way in and out, so a socket accepted by an older release
 * (with an older attachment shape) reads as `null` instead of a wrongly typed value.
 *
 * Keep attachments small: the runtime limits a serialised attachment to 2,048 bytes.
 */

export const MAX_ATTACHMENT_BYTES = 2048;

export function setAttachment<S extends z.ZodType>(ws: WebSocket, schema: S, value: z.input<S>): void {
  const parsed: unknown = schema.parse(value);
  ws.serializeAttachment(parsed);
}

export function getAttachment<S extends z.ZodType>(ws: WebSocket, schema: S): z.infer<S> | null {
  const raw: unknown = ws.deserializeAttachment();
  if (raw === null || raw === undefined) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
