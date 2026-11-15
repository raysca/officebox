import { apiError, err, ok, type ApiError, type PasswordSignInBody, type Result } from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { checkLimit } from "../../core/rate-limit";
import { base64url, hmacSha256 } from "./crypto";
import { clientIp, deviceInfo, ipBucket } from "./device";
import { knownDeviceId, newDeviceId, signKnownDevice, type DeviceBinding } from "./known-device";
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
 * 3. **Slow mode, across IPs:** when 10 distinct IP buckets have tried the account (and failed) in the
 *    current hour, the account is in slow mode for the rest of that hour; it re-arms each hour. In slow
 *    mode a browser without a valid known-device cookie gets in by one of two lanes:
 *    - **Clean lane:** a bucket that hasn't tried the account this hour goes straight to the password
 *      check, once. The claim is an atomic insert, so parallel requests from one bucket get one try.
 *      A failure leaves the bucket in the set; a success releases it. So the owner's usual IP gets in
 *      at once even while an attacker holds the slot.
 *    - **Shared slot:** every other request shares one attempt per account every 30 seconds, reserved
 *      in one guarded upsert; refused requests never reach PBKDF2.
 *    Known devices skip both.
 *    **Bounds, stated plainly:** below the threshold, guessing is bounded by the per-IP schedule (about
 *    130 an hour) times the number of IP buckets, up to 9 of them; above it, by the shared slot (about
 *    120 an hour) plus one clean-lane attempt per new bucket. **Limits:** an attacker behind the same
 *    shared IP (NAT, CGNAT) as the owner keeps that bucket out of the clean lane and in the per-IP
 *    wait; known devices avoid this, and magic links (M1c) will too. M1a has no other way in yet.
 * 4. **Counting:** the per-IP schedule is reserved first and atomically before verification, so a
 *    request it refuses never takes the shared slot (it still counts against that IP). Only failures
 *    (or clean-lane claims) add an IP bucket.
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
export const SLOW_MODE_BUCKETS = 10;
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
 * Adds this IP bucket to the account's set for the hour of the attempt, and says whether it was new.
 * Outside slow mode it records a failure (after verification). In slow mode it is also the clean-lane
 * claim, made atomically **before** verification: only the request that inserts the row gets the
 * bucket's one clean-lane attempt this hour; every later request from the bucket queues for the slot.
 */
async function addBucket(ctx: CoreContext, account: string, bucket: string, at: number): Promise<boolean> {
  const meta = expectOk(
    await new Database(ctx.env.DB).run(
      "INSERT OR IGNORE INTO sign_in_failure_buckets (account_key, window_start, bucket_key) VALUES (?, ?, ?)",
      account,
      hourStart(at),
      bucket,
    ),
  );
  return meta.changes === 1;
}

/**
 * Releases a clean-lane claim after a **successful** sign-in, so the owner's own IP stays clean. The
 * claim was made in slow mode, which means at least the threshold of other buckets is already in the
 * set: removing this one can't switch slow mode off or let anyone else through.
 */
async function releaseBucket(ctx: CoreContext, account: string, bucket: string, at: number): Promise<void> {
  expectOk(
    await new Database(ctx.env.DB).run(
      "DELETE FROM sign_in_failure_buckets WHERE account_key = ? AND window_start = ? AND bucket_key = ?",
      account,
      hourStart(at),
      bucket,
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
  password_version: number;
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
      "SELECT id, password_hash, password_version, status, session_epoch FROM users WHERE email = ? AND status <> 'deleted'",
      body.email,
    ),
  );
  const binding = (row: SignInUserRow): DeviceBinding => ({
    accountKey: account,
    sessionEpoch: row.session_epoch,
    passwordVersion: row.password_version,
  });
  // Checked the same way without an account (a binding nothing can match), so timing doesn't differ.
  const checked = await knownDeviceId(
    secrets.sessionKeys,
    knownDeviceCookie,
    binding(user ?? { id: "", password_hash: null, password_version: -1, status: "deleted", session_epoch: -1 }),
    ctx.now(),
  );
  const deviceId = user?.status === "active" ? checked : null;

  // The per-IP schedule first, so a request it refuses never takes the shared slot.
  const throttleKey = await accountIpKey(secrets, body.email, ip, deviceId);
  const attemptAt = ctx.now();
  const reserved = await reserveAttempt(ctx, throttleKey);
  if (!reserved.ok) return reserved;

  const bucket = await hmac(secrets, `sign-in-bucket:${ipBucket(ip)}`);
  let claimedCleanLane = false;
  if (!deviceId && (await inSlowMode(ctx, account))) {
    // Clean lane: a bucket with no attempt on this account this hour goes straight to the password
    // check, once. Otherwise the shared 30-second slot.
    claimedCleanLane = await addBucket(ctx, account, bucket, attemptAt);
    if (!claimedCleanLane) {
      const slot = await reserveSlot(ctx, account);
      if (!slot.ok) return slot;
    }
  }

  const result = await verifyPassword(user?.password_hash ?? null, body.password, secrets.peppers);
  if (!result.valid || !user) {
    if (user && result.unknownPepper) {
      // A retired pepper's secret was deleted (or a restore lacks it): this account must reset.
      ctx.log.warn("password hash uses a pepper that isn't configured", { userId: user.id });
    }
    if (!claimedCleanLane) await addBucket(ctx, account, bucket, attemptAt);
    return err(INVALID);
  }
  if (user.status !== "active") return err(CANT_SIGN_IN);

  await resetAttempts(ctx, throttleKey);
  if (claimedCleanLane) await releaseBucket(ctx, account, bucket, attemptAt);
  if (result.needsRehash && user.password_hash) {
    // Compare-and-set, so a password changed meanwhile isn't overwritten with the old one. A re-hash
    // keeps password_version: the password itself didn't change, so known devices stay known.
    expectOk(
      await db.run(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash = ?",
        await hashPassword(body.password, secrets.peppers),
        ctx.now(),
        user.id,
        user.password_hash,
      ),
    );
  }
  const signingKey = secrets.sessionKeys[0];
  if (!signingKey) throw new Error("No session signing key");
  return ok({
    session: await createSession(ctx, secrets, { id: user.id, sessionEpoch: user.session_epoch }, deviceInfo(request)),
    knownDevice: await signKnownDevice(signingKey, binding(user), deviceId ?? newDeviceId(), ctx.now()),
  });
}
