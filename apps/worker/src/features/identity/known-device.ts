import { z } from "zod";
import { base64url, fromBase64url, hmacSha256, randomToken, timingSafeEqual } from "./crypto";

/**
 * The "known device" marker (Identity §2 Decisions, §4.4, §4.5 **(default)**): a signed, long-lived
 * `ob_device` cookie set after a successful password sign-in in this browser.
 *
 * - **What it does:** when an account is in slow mode (a distributed guessing attack), browsers with a
 *   valid marker for the account skip the shared 30-second slot, and their per-IP delay is keyed by
 *   the device too, so others failing from the same IP (a shared NAT) don't delay them.
 * - **What it doesn't do:** it is not a session and never skips the password.
 * - **Bound to:** the account (the HMAC of the email that keys the throttle), the user's
 *   `session_epoch` and `users.password_version`, which only a real password change or reset bumps
 *   (never a pepper or policy re-hash). Sign out everywhere, a password change and disabling the
 *   member (status is checked too) all invalidate it.
 * - **Signed** with `SESSION_SIGNING_KEY` (the previous key verifies too) under its own context
 *   string. It carries a random device ID and its issue time, and expires after 400 days.
 */

export const KNOWN_DEVICE_COOKIE = "ob_device";
/** Browsers cap cookie lifetimes at 400 days. */
export const KNOWN_DEVICE_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const CONTEXT = "ob_device.v3.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const payloadSchema = z.strictObject({
  v: z.literal(3),
  a: z.string().max(100), // account key
  d: z.string().regex(/^[A-Za-z0-9_-]{22}$/), // device ID
  e: z.number().int().nonnegative(), // session_epoch
  p: z.number().int(), // users.password_version
  iat: z.number().int(),
});

export interface DeviceBinding {
  accountKey: string;
  sessionEpoch: number;
  passwordVersion: number;
}

export function newDeviceId(): string {
  return randomToken(16);
}

export async function signKnownDevice(
  key: string,
  binding: DeviceBinding,
  deviceId: string,
  now: number,
): Promise<string> {
  const payload = {
    v: 3,
    a: binding.accountKey,
    d: deviceId,
    e: binding.sessionEpoch,
    p: binding.passwordVersion,
    iat: now,
  };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${base64url(await hmacSha256(key, CONTEXT + body))}`;
}

const same = (a: string, b: string) => timingSafeEqual(encoder.encode(a), encoder.encode(b));

/** The device ID of a valid, unexpired marker matching `binding`, or null. Never throws. */
export async function knownDeviceId(
  keys: readonly string[],
  cookie: string | undefined,
  binding: DeviceBinding,
  now: number,
): Promise<string | null> {
  if (!cookie || cookie.length > 1024) return null;
  const [body, signature, extra] = cookie.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const presented = fromBase64url(signature);
  if (!presented) return null;
  let signed = false;
  for (const key of keys) if (timingSafeEqual(await hmacSha256(key, CONTEXT + body), presented)) signed = true;
  if (!signed) return null;
  const bytes = fromBase64url(body);
  if (!bytes) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(decoder.decode(bytes)));
    if (!parsed.success) return null;
    const p = parsed.data;
    const valid =
      same(p.a, binding.accountKey) &&
      p.e === binding.sessionEpoch &&
      p.p === binding.passwordVersion &&
      now - p.iat < KNOWN_DEVICE_TTL_MS;
    return valid ? p.d : null;
  } catch {
    return null;
  }
}
