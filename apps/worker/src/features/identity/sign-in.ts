import { apiError, err, ok, type ApiError, type PasswordSignInBody, type Result } from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { checkLimit } from "../../core/rate-limit";
import { base64url, hmacSha256 } from "./crypto";
import { clientIp, deviceInfo, ipBucket } from "./device";
import { knownDeviceId, newDeviceId, passwordVersion, signKnownDevice, type DeviceBinding } from "./known-device";
import { IDENTITY_LIMITS } from "./limits";
import { hashPassword, verifyPassword } from "./password";
import type { IdentitySecrets } from "./secrets";
import { createSession, type IssuedSession } from "./sessions";
import { isSetupComplete } from "./setup-state";

/**
 * Email and password sign-in (Identity §4.4; throttling design in Identity §2 Decisions, **default**).
 *
 * 1. **Per IP:** 5 attempts per minute (Rate Limiting binding, advisory; Platform §8).
 * 2. **Per account and IP:** a D1 counter keyed by an HMAC of the email and the client's IP bucket (the
 *    address for IPv4, its /64 for IPv6), plus the device ID for a known device (so others failing
 *    behind the same NAT don't delay it). Attempts 1–5 go ahead immediately; after that each attempt
 *    must wait 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s (the cap) after the previous one. An attempt made
 *    too soon is refused with `rate_limited` and a retry-after, without checking the password and
 *    without counting. An attacker's attempts only slow the attacker's own IP for that account.
 * 3. **Slow mode, across IPs:** when 20 distinct IP buckets have had a failed attempt on the account in
 *    the current hour, browsers **without** a valid known-device cookie share one sign-in slot per
 *    account every 30 seconds. The slot is reserved in one guarded upsert, so parallel requests can't
 *    slip through, and refused requests never reach PBKDF2. This bounds distributed guessing at about
 *    120 attempts an hour per account. One IP can never trip it. Known devices are unaffected.
 *    **Limit, stated plainly:** during a distributed attack, sign-in from new browsers can be slowed to
 *    roughly one attempt per 30 seconds per account, shared with the attacker; magic links (M1c) and
 *    admin recovery links aren't throttled this way and remain the way in.
 * 4. **Counting:** only attempts that reach the password check count towards the per-IP schedule (taken
 *    atomically before verification), and only failed ones add an IP bucket.
 * 5. **No enumeration:** every key is derived from the submitted email whether or not an account
 *    exists, the user row is read either way, verification costs one full PBKDF2 derivation either way
 *    (`password.ts`), and both failures return the same `invalid_credentials` error. An unknown email
 *    can never have a known device, exactly like a real account seen from a new browser.
 * 6. **Disabled and deleted members** get a generic "can't sign in", only after the right password.
 * 7. **Pepper rotation:** a hash on an older pepper or policy is re-hashed after a successful sign-in.
 */

export const FREE_ATTEMPTS = 5;
export const MAX_DELAY_MS = 30_000;
export const THROTTLE_WINDOW_MS = 60 * 60 * 1000;
/** Distinct failing IP buckets per account per hour that switch on slow mode (default). */
export const SLOW_MODE_BUCKETS = 20;
/** In slow mode, unknown devices share one attempt per account per this interval (default). */
export const SLOW_MODE_SLOT_MS = 30_000;

/** The wait required after `attempts` recorded attempts: 0 for the first five, then 1 s doubling to 30 s. */
export function throttleDelayMs(attempts: number): number {
  if (attempts < FREE_ATTEMPTS) return 0;
  return Math.min(1000 * 2 ** (attempts - FREE_ATTEMPTS), MAX_DELAY_MS);
}

// The same schedule in SQL: 1000 << (attempts - 5) is 1 s … 16 s for 5–9 recorded attempts, and from
// 10 on the 30 s cap applies (32 s would exceed it).
const SQL_DELAY = `CASE WHEN attempts < ${FREE_ATTEMPTS} THEN 0
                        WHEN attempts >= ${FREE_ATTEMPTS + 5} THEN ${MAX_DELAY_MS}
                        ELSE 1000 * (1 << (attempts - ${FREE_ATTEMPTS})) END`;

const INVALID: ApiError = apiError("invalid_credentials", "The email or password is incorrect.");
const CANT_SIGN_IN: ApiError = apiError("forbidden", "This account can't sign in. Contact an admin.");

function tooMany(waitMs: number): ApiError {
  return apiError("rate_limited", "Too many sign-in attempts. Wait a moment and try again.", {
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
  });
}

const hmac = async (secrets: IdentitySecrets, value: string) =>
  base64url(await hmacSha256(secrets.tokenHashKey, value));

/** The account's throttle identity: an HMAC of the email, the same whether or not the account exists. */
export function accountKey(secrets: IdentitySecrets, email: string): Promise<string> {
  return hmac(secrets, `sign-in:${email.toLowerCase()}`);
}

/** The per-account, per-IP (and, for a known device, per-device) throttle key. */
export function accountIpKey(
  secrets: IdentitySecrets,
  email: string,
  ip: string,
  deviceId: string | null,
): Promise<string> {
  const device = deviceId ? `|device:${deviceId}` : "";
  return hmac(secrets, `sign-in-ip:${email.toLowerCase()}|${ipBucket(ip)}${device}`);
}

/** Counts an attempt for `key` if the schedule allows one now; otherwise says how long to wait. */
export async function reserveAttempt(ctx: CoreContext, key: string): Promise<Result<void, ApiError>> {
  const now = ctx.now();
  const quietSince = now - THROTTLE_WINDOW_MS;
  const db = new Database(ctx.env.DB);
  const reserved = expectOk(
    await db.first<{ attempts: number }>(
      `INSERT INTO sign_in_throttle (account_key, attempts, last_attempt_at) VALUES (?1, 1, ?2)
       ON CONFLICT (account_key) DO UPDATE SET
         attempts = CASE WHEN last_attempt_at <= ?3 THEN 1 ELSE attempts + 1 END,
         last_attempt_at = ?2
       WHERE last_attempt_at <= ?3 OR last_attempt_at + (${SQL_DELAY}) <= ?2
       RETURNING attempts`,
      key,
      now,
      quietSince,
    ),
  );
  if (reserved) return ok();
  const row = expectOk(
    await db.first<{ attempts: number; last_attempt_at: number }>(
      "SELECT attempts, last_attempt_at FROM sign_in_throttle WHERE account_key = ?",
      key,
    ),
  );
  return err(tooMany(row ? row.last_attempt_at + throttleDelayMs(row.attempts) - now : 1000));
}

function hourStart(at: number): number {
  return Math.floor(at / THROTTLE_WINDOW_MS) * THROTTLE_WINDOW_MS;
}

/** Whether the account is in slow mode: enough distinct IP buckets failed on it this hour. */
async function inSlowMode(ctx: CoreContext, account: string): Promise<boolean> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sign_in_failure_buckets WHERE account_key = ? AND window_start = ?",
      account,
      hourStart(ctx.now()),
    ),
  );
  return (row?.n ?? 0) >= SLOW_MODE_BUCKETS;
}

/** Takes the account's shared slow-mode slot in one statement, or says when the next one opens. */
export async function reserveSlot(ctx: CoreContext, account: string): Promise<Result<void, ApiError>> {
  const now = ctx.now();
  const db = new Database(ctx.env.DB);
  const taken = expectOk(
    await db.first<{ next_allowed_at: number }>(
      `INSERT INTO sign_in_slots (account_key, next_allowed_at) VALUES (?1, ?2)
       ON CONFLICT (account_key) DO UPDATE SET next_allowed_at = ?2 WHERE next_allowed_at <= ?3
       RETURNING next_allowed_at`,
      account,
      now + SLOW_MODE_SLOT_MS,
      now,
    ),
  );
  if (taken) return ok();
  const row = expectOk(
    await db.first<{ next_allowed_at: number }>(
      "SELECT next_allowed_at FROM sign_in_slots WHERE account_key = ?",
      account,
    ),
  );
  return err(tooMany((row?.next_allowed_at ?? now + 1000) - now));
}

/**
 * Records that this IP bucket failed on the account in the hour of the attempt. The set only grows
 * within an hour and nothing is refunded on success, so a correct password can never let an extra
 * unknown device through.
 */
async function recordFailure(ctx: CoreContext, secrets: IdentitySecrets, account: string, ip: string, at: number) {
  expectOk(
    await new Database(ctx.env.DB).run(
      "INSERT OR IGNORE INTO sign_in_failure_buckets (account_key, window_start, bucket_key) VALUES (?, ?, ?)",
      account,
      hourStart(at),
      await hmac(secrets, `sign-in-bucket:${ipBucket(ip)}`),
    ),
  );
}

async function resetAttempts(ctx: CoreContext, key: string): Promise<void> {
  expectOk(await new Database(ctx.env.DB).run("DELETE FROM sign_in_throttle WHERE account_key = ?", key));
}

/**
 * Deletes throttle state that can no longer affect anything: per-IP rows idle for the window, failure
 * buckets of past hours and slots that opened over an hour ago. Runs hourly, which bounds the rows
 * unknown emails can leave behind.
 */
export async function pruneSignInThrottle(ctx: CoreContext): Promise<number> {
  const now = ctx.now();
  const cutoff = now - THROTTLE_WINDOW_MS;
  const db = new Database(ctx.env.DB);
  const results = expectOk(
    await db.batchRun([
      db.statement("DELETE FROM sign_in_throttle WHERE last_attempt_at <= ?", cutoff),
      db.statement("DELETE FROM sign_in_failure_buckets WHERE window_start < ?", hourStart(now)),
      db.statement("DELETE FROM sign_in_slots WHERE next_allowed_at <= ?", cutoff),
    ]),
  );
  return results.reduce((sum, r) => sum + r.changes, 0);
}

interface SignInUserRow {
  id: string;
  password_hash: string | null;
  status: string;
  session_epoch: number;
}

export interface SignedIn {
  session: IssuedSession;
  /** A fresh known-device marker for this browser and account. */
  knownDevice: string;
}

export async function signInWithPassword(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  body: PasswordSignInBody,
  request: Request,
  knownDeviceCookie: string | undefined,
): Promise<Result<SignedIn, ApiError>> {
  const ip = clientIp(request);
  const ipLimit = await checkLimit(ctx, IDENTITY_LIMITS.signInIp, ip);
  if (!ipLimit.ok) return ipLimit;
  if (!(await isSetupComplete(ctx))) return err(apiError("setup_required", "This workspace hasn't been set up yet."));

  const account = await accountKey(secrets, body.email);
  const db = new Database(ctx.env.DB);
  // Read for every request, account or not, so both paths do the same work before verification.
  const user = expectOk(
    await db.first<SignInUserRow>(
      "SELECT id, password_hash, status, session_epoch FROM users WHERE email = ? AND status <> 'deleted'",
      body.email,
    ),
  );
  const binding = async (row: SignInUserRow): Promise<DeviceBinding> => ({
    accountKey: account,
    sessionEpoch: row.session_epoch,
    passwordVersion: await passwordVersion(secrets.tokenHashKey, row.password_hash),
  });
  // Checked the same way without an account (a binding nothing can match), so timing doesn't differ.
  const checked = await knownDeviceId(
    secrets.sessionKeys,
    knownDeviceCookie,
    await binding(user ?? { id: "", password_hash: null, status: "deleted", session_epoch: -1 }),
    ctx.now(),
  );
  const deviceId = user?.status === "active" ? checked : null;

  if (!deviceId && (await inSlowMode(ctx, account))) {
    const slot = await reserveSlot(ctx, account);
    if (!slot.ok) return slot;
  }
  const throttleKey = await accountIpKey(secrets, body.email, ip, deviceId);
  const attemptAt = ctx.now();
  const reserved = await reserveAttempt(ctx, throttleKey);
  if (!reserved.ok) return reserved;

  const result = await verifyPassword(user?.password_hash ?? null, body.password, secrets.peppers);
  if (!result.valid || !user) {
    if (user && result.unknownPepper) {
      // A retired pepper's secret was deleted (or a restore lacks it): this account must reset.
      ctx.log.warn("password hash uses a pepper that isn't configured", { userId: user.id });
    }
    await recordFailure(ctx, secrets, account, ip, attemptAt);
    return err(INVALID);
  }
  if (user.status !== "active") return err(CANT_SIGN_IN);

  await resetAttempts(ctx, throttleKey);
  let current = user;
  if (result.needsRehash && user.password_hash) {
    // Compare-and-set, so a password changed meanwhile isn't overwritten with the old one.
    const rehashed = await hashPassword(body.password, secrets.peppers);
    const meta = expectOk(
      await db.run(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash = ?",
        rehashed,
        ctx.now(),
        user.id,
        user.password_hash,
      ),
    );
    if (meta.changes === 1) current = { ...user, password_hash: rehashed };
  }
  const signingKey = secrets.sessionKeys[0];
  if (!signingKey) throw new Error("No session signing key");
  return ok({
    session: await createSession(ctx, secrets, { id: user.id, sessionEpoch: user.session_epoch }, deviceInfo(request)),
    knownDevice: await signKnownDevice(signingKey, await binding(current), deviceId ?? newDeviceId(), ctx.now()),
  });
}
