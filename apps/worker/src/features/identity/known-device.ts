import { z } from "zod";
import { base64url, fromBase64url, hmacSha256, timingSafeEqual } from "./crypto";

/**
 * The "known device" marker (Identity §4.4, sign-in throttling **(default)**): a signed, long-lived
 * `ob_device` cookie set after a successful password sign-in in this browser, bound to that account.
 * When an account is under a distributed guessing attack and its cross-IP ceiling trips, browsers that
 * carry a valid marker for the account keep the normal per-IP schedule, so its owner can still sign
 * in; everyone else waits for the window to pass.
 *
 * It grants nothing on its own: it is not a session and never skips the password. It is signed with
 * `SESSION_SIGNING_KEY` (the previous key verifies too) under its own context string, and names the
 * account only by the same HMAC of the email that keys the throttle.
 */

export const KNOWN_DEVICE_COOKIE = "ob_device";
/** Browsers cap cookie lifetimes at 400 days. */
export const KNOWN_DEVICE_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const CONTEXT = "ob_device.v1.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const payloadSchema = z.strictObject({ v: z.literal(1), a: z.string().max(100), iat: z.number().int() });

export async function signKnownDevice(key: string, accountKey: string, now: number): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify({ v: 1, a: accountKey, iat: now })));
  return `${body}.${base64url(await hmacSha256(key, CONTEXT + body))}`;
}

/** Whether `cookie` is a valid, unexpired marker for `accountKey`. Never throws. */
export async function isKnownDevice(
  keys: readonly string[],
  cookie: string | undefined,
  accountKey: string,
  now: number,
): Promise<boolean> {
  if (!cookie || cookie.length > 512) return false;
  const [body, signature, extra] = cookie.split(".");
  if (!body || !signature || extra !== undefined) return false;
  const presented = fromBase64url(signature);
  if (!presented) return false;
  let signed = false;
  for (const key of keys) if (timingSafeEqual(await hmacSha256(key, CONTEXT + body), presented)) signed = true;
  if (!signed) return false;
  const bytes = fromBase64url(body);
  if (!bytes) return false;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(decoder.decode(bytes)));
    return (
      parsed.success &&
      timingSafeEqual(encoder.encode(parsed.data.a), encoder.encode(accountKey)) &&
      now - parsed.data.iat < KNOWN_DEVICE_TTL_MS
    );
  } catch {
    return false;
  }
}
