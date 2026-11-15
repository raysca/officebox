import { Database, expectOk } from "../../core/db";
import { randomToken, tokenHash } from "./crypto";

/**
 * Known devices (Identity §4.4 "new device", §5 `user_devices`; default): a random ID in an `HttpOnly`,
 * `Secure`, `__Host-` cookie with `Path=/`, **set on every successful sign-in, by passkey or magic
 * link**, and recorded per member as HMAC(TOKEN_HASH_KEY, value). A magic-link sign-in from a browser
 * without a known device cookie for that member raises a `security_notice`. Rows unused for 400 days
 * are deleted by the daily prune (and the cookie lasts as long).
 */

export const DEVICE_COOKIE = "__Host-officebox-device";
export const DEVICE_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE_MAX_AGE = Math.floor(DEVICE_RETENTION_MS / 1000);

/** The device ID from a Cookie header, if it has the shape we issue (43 base64url characters). */
export function readDeviceCookie(headers: Headers | undefined): string | null {
  const raw = headers?.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === DEVICE_COOKIE) {
      const value = rest.join("=");
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function deviceCookie(value: string): string {
  return `${DEVICE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE}`;
}

export interface DeviceOutcome {
  /** True when this member had never signed in from this browser before. */
  isNew: boolean;
  /** The Set-Cookie value to send (always refreshed, so the cookie lives as long as the row). */
  setCookie: string;
}

/**
 * Records a sign-in from the request's browser for `userId`: reuses the browser's device ID if it has
 * one, or issues a new one, and upserts the member's row. Says whether the device was new to them.
 */
export async function recordSignInDevice(
  db: D1Database,
  key: string,
  userId: string,
  headers: Headers | undefined,
  now: number,
): Promise<DeviceOutcome> {
  const value = readDeviceCookie(headers) ?? randomToken(32);
  const hash = await tokenHash(key, `device:${value}`);
  const database = new Database(db);
  // The insert returns a row only when it created one: that's the "new device" answer, race-free.
  const inserted = expectOk(
    await database.first<{ user_id: string }>(
      `INSERT INTO user_devices (user_id, device_hash, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (user_id, device_hash) DO NOTHING
       RETURNING user_id`,
      userId,
      hash,
      now,
    ),
  );
  if (!inserted) {
    expectOk(
      await database.run(
        "UPDATE user_devices SET last_seen_at = ? WHERE user_id = ? AND device_hash = ?",
        now,
        userId,
        hash,
      ),
    );
  }
  return { isNew: inserted !== null, setCookie: deviceCookie(value) };
}
