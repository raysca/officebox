import { apiError, err, ok, type ApiError, type PasswordSignInBody, type Result } from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { checkLimit } from "../../core/rate-limit";
import { base64url, hmacSha256 } from "./crypto";
import { clientIp, deviceInfo, ipBucket } from "./device";
import { isKnownDevice, signKnownDevice } from "./known-device";
import { IDENTITY_LIMITS } from "./limits";
import { hashPassword, verifyPassword } from "./password";
import type { IdentitySecrets } from "./secrets";
import { createSession, type IssuedSession } from "./sessions";
import { isSetupComplete } from "./setup-state";

/**
 * Email and password sign-in (Identity §4.4; throttling design in Identity §2 Decisions, **default**).
 *
 * 1. **Per IP:** 5 attempts per minute (Rate Limiting binding, advisory; Platform §8).
 * 2. **Per account and IP:** a D1 counter keyed by an HMAC of the email **and** the client's IP bucket
 *    (the address for IPv4, its /64 for IPv6). Attempts 1–5 go ahead immediately; after that each
 *    attempt must wait 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s (the cap) after the previous one from that
 *    IP. An attempt made too soon is refused with `rate_limited` and a retry-after, without checking
 *    the password and without counting. An attacker's attempts therefore only slow the attacker's own
 *    IP for that account: the real user, from another IP, is unaffected (no lockout, TDD §8.1).
 * 3. **Per account, across IPs:** a ceiling of 50 attempts that reached the password check per fixed
 *    hour (successes are taken back off). When it trips, browsers **without** a valid known-device
 *    cookie for the account (`known-device.ts`) are refused until the hour ends; known devices keep
 *    the normal per-IP schedule, so the owner can still sign in during a distributed attack.
 * 4. **Counting:** only attempts that reach the password check count. The per-IP counter is taken
 *    atomically before verification, so parallel guesses can't slip past it. The ceiling is checked
 *    before and counted after that reservation; parallel requests can overshoot it slightly, which is
 *    harmless for a limit this generous.
 * 5. **No enumeration:** every key is derived from the submitted email whether or not an account
 *    exists, verification costs one full PBKDF2 derivation either way (`password.ts`), and both
 *    failures return the same `invalid_credentials` error.
 * 6. **Disabled and deleted members** get a generic "can't sign in", only after the right password.
 * 7. **Pepper rotation:** a hash on an older pepper or policy is re-hashed after a successful sign-in.
 */

export const FREE_ATTEMPTS = 5;
export const MAX_DELAY_MS = 30_000;
export const THROTTLE_WINDOW_MS = 60 * 60 * 1000;
/** Cross-IP attempts per account per hour before unknown devices are held back (default). */
export const ACCOUNT_CEILING = 50;
const CEILING_SCOPE = "sign_in_account";

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

/** The account's throttle identity: an HMAC of the email, the same whether or not the account exists. */
export async function accountKey(secrets: IdentitySecrets, email: string): Promise<string> {
  return base64url(await hmacSha256(secrets.tokenHashKey, `sign-in:${email.toLowerCase()}`));
}

/** The per-account, per-IP throttle key. */
export async function accountIpKey(secrets: IdentitySecrets, email: string, ip: string): Promise<string> {
  return base64url(await hmacSha256(secrets.tokenHashKey, `sign-in-ip:${email.toLowerCase()}|${ipBucket(ip)}`));
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

function ceilingWindow(now: number): { start: number; end: number } {
  const start = Math.floor(now / THROTTLE_WINDOW_MS) * THROTTLE_WINDOW_MS;
  return { start, end: start + THROTTLE_WINDOW_MS };
}

/** Refuses an unknown device while the account's cross-IP ceiling is tripped. */
async function checkCeiling(ctx: CoreContext, key: string): Promise<Result<void, ApiError>> {
  const now = ctx.now();
  const { start, end } = ceilingWindow(now);
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ count: number }>(
      "SELECT count FROM rate_counters WHERE scope = ? AND key = ? AND window_start = ?",
      CEILING_SCOPE,
      key,
      start,
    ),
  );
  return (row?.count ?? 0) >= ACCOUNT_CEILING ? err(tooMany(end - now)) : ok();
}

async function adjustCeiling(ctx: CoreContext, key: string, delta: 1 | -1): Promise<void> {
  const { start } = ceilingWindow(ctx.now());
  const db = new Database(ctx.env.DB);
  expectOk(
    delta === 1
      ? await db.run(
          `INSERT INTO rate_counters (scope, key, window_start, count) VALUES (?, ?, ?, 1)
           ON CONFLICT (scope, key, window_start) DO UPDATE SET count = count + 1`,
          CEILING_SCOPE,
          key,
          start,
        )
      : await db.run(
          "UPDATE rate_counters SET count = count - 1 WHERE scope = ? AND key = ? AND window_start = ? AND count > 0",
          CEILING_SCOPE,
          key,
          start,
        ),
  );
}

async function resetAttempts(ctx: CoreContext, key: string): Promise<void> {
  expectOk(await new Database(ctx.env.DB).run("DELETE FROM sign_in_throttle WHERE account_key = ?", key));
}

/**
 * Deletes throttle state that can no longer affect anything: per-IP rows idle for the window, and
 * ceiling counters for past windows. Runs hourly, which bounds the rows unknown emails can leave behind.
 */
export async function pruneSignInThrottle(ctx: CoreContext): Promise<number> {
  const cutoff = ctx.now() - THROTTLE_WINDOW_MS;
  const db = new Database(ctx.env.DB);
  const [rows, counters] = expectOk(
    await db.batchRun([
      db.statement("DELETE FROM sign_in_throttle WHERE last_attempt_at <= ?", cutoff),
      db.statement("DELETE FROM rate_counters WHERE scope = ? AND window_start < ?", CEILING_SCOPE, cutoff),
    ]),
  );
  return (rows?.changes ?? 0) + (counters?.changes ?? 0);
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
  const known = await isKnownDevice(secrets.sessionKeys, knownDeviceCookie, account, ctx.now());
  if (!known) {
    const ceiling = await checkCeiling(ctx, account);
    if (!ceiling.ok) return ceiling;
  }
  const throttleKey = await accountIpKey(secrets, body.email, ip);
  const reserved = await reserveAttempt(ctx, throttleKey);
  if (!reserved.ok) return reserved;
  await adjustCeiling(ctx, account, 1);

  const db = new Database(ctx.env.DB);
  const user = expectOk(
    await db.first<SignInUserRow>(
      "SELECT id, password_hash, status, session_epoch FROM users WHERE email = ? AND status <> 'deleted'",
      body.email,
    ),
  );
  const result = await verifyPassword(user?.password_hash ?? null, body.password, secrets.peppers);
  if (!result.valid || !user) {
    if (user && result.unknownPepper) {
      // A retired pepper's secret was deleted (or a restore lacks it): this account must reset.
      ctx.log.warn("password hash uses a pepper that isn't configured", { userId: user.id });
    }
    return err(INVALID);
  }
  if (user.status !== "active") return err(CANT_SIGN_IN);

  await resetAttempts(ctx, throttleKey);
  await adjustCeiling(ctx, account, -1);
  if (result.needsRehash && user.password_hash) {
    // Compare-and-set, so a password changed meanwhile isn't overwritten with the old one.
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
    knownDevice: await signKnownDevice(signingKey, account, ctx.now()),
  });
}
