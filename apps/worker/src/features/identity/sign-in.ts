import { apiError, err, ok, type ApiError, type PasswordSignInBody, type Result } from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { checkLimit } from "../../core/rate-limit";
import { base64url, hmacSha256 } from "./crypto";
import { clientIp, deviceInfo } from "./device";
import { IDENTITY_LIMITS } from "./limits";
import { hashPassword, verifyPassword } from "./password";
import type { IdentitySecrets } from "./secrets";
import { createSession, type IssuedSession } from "./sessions";
import { isSetupComplete } from "./setup-state";

/**
 * Email and password sign-in (Identity §4.4).
 *
 * 1. **Per IP:** 5 attempts per minute (Rate Limiting binding, advisory; Platform §8).
 * 2. **Per account:** a D1 counter keyed by an HMAC of the email, so unknown emails behave exactly
 *    like real accounts. Attempts 1–5 go ahead immediately; after that each attempt must wait 1 s,
 *    2 s, 4 s, 8 s, 16 s, then 30 s (the cap) after the previous one. An attempt made too soon is
 *    refused with `rate_limited` and a retry-after, without checking the password and without
 *    counting **(default: the delay is enforced by refusing early attempts, not by holding the
 *    request open)**. A successful sign-in resets the counter; an hour without attempts does too.
 *    There is no lockout: a correct password after the wait succeeds. The attempt is counted
 *    atomically **before** the password is checked, so parallel guesses can't all slip through.
 * 3. **Verification** costs one full PBKDF2 derivation whether or not the account exists
 *    (`password.ts`), and both failures return the same `invalid_credentials` error.
 * 4. **Disabled and deleted members** get a generic "can't sign in", only after the right password.
 * 5. **Pepper rotation:** a hash on an older pepper or policy is re-hashed after a successful sign-in.
 */

export const FREE_ATTEMPTS = 5;
export const MAX_DELAY_MS = 30_000;
export const THROTTLE_WINDOW_MS = 60 * 60 * 1000;

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

async function accountKey(secrets: IdentitySecrets, email: string): Promise<string> {
  return base64url(await hmacSha256(secrets.tokenHashKey, `sign-in:${email.toLowerCase()}`));
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
  const waitMs = row ? row.last_attempt_at + throttleDelayMs(row.attempts) - now : 1000;
  return err(
    apiError("rate_limited", "Too many sign-in attempts. Wait a moment and try again.", {
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
    }),
  );
}

async function resetAttempts(ctx: CoreContext, key: string): Promise<void> {
  expectOk(await new Database(ctx.env.DB).run("DELETE FROM sign_in_throttle WHERE account_key = ?", key));
}

/** Deletes throttle rows idle for longer than the window (daily). */
export async function pruneSignInThrottle(ctx: CoreContext): Promise<number> {
  const meta = expectOk(
    await new Database(ctx.env.DB).run(
      "DELETE FROM sign_in_throttle WHERE last_attempt_at <= ?",
      ctx.now() - THROTTLE_WINDOW_MS,
    ),
  );
  return meta.changes;
}

interface SignInUserRow {
  id: string;
  password_hash: string | null;
  status: string;
  session_epoch: number;
}

export async function signInWithPassword(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  body: PasswordSignInBody,
  request: Request,
): Promise<Result<IssuedSession, ApiError>> {
  const ipLimit = await checkLimit(ctx, IDENTITY_LIMITS.signInIp, clientIp(request));
  if (!ipLimit.ok) return ipLimit;
  if (!(await isSetupComplete(ctx))) return err(apiError("setup_required", "This workspace hasn't been set up yet."));

  const key = await accountKey(secrets, body.email);
  const reserved = await reserveAttempt(ctx, key);
  if (!reserved.ok) return reserved;

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

  await resetAttempts(ctx, key);
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
  return ok(await createSession(ctx, secrets, { id: user.id, sessionEpoch: user.session_epoch }, deviceInfo(request)));
}
