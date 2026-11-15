import type { ApiError, Result } from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { checkLimit, defineLimit } from "../../core/rate-limit";
import { clientIp, ipBucket } from "./device";

/**
 * Identity rate limits (Platform §8; Identity §4.4, §4.5). **Enforced in our middleware before
 * `auth.handler`**; better-auth's own limiter is only a backstop, on the same `rate_counters` table
 * through {@link consumeRateLimit} (M1a-0 spike, workaround 14). Per-IP keys use `cf-connecting-ip`
 * with IPv6 grouped by /64.
 */
export const IDENTITY_LIMITS = {
  /** Setup and setup resume: 5 per minute per IP. */
  setup: defineLimit({ mechanism: "binding", name: "setup", binding: "AUTH_RATE_LIMITER", periodSeconds: 60 }),
  /** Passkey sign-in and registration (options and verify), and step-up attempts: 20 per minute per IP. */
  passkeyIp: defineLimit({ mechanism: "binding", name: "passkey", binding: "PASSKEY_RATE_LIMITER", periodSeconds: 60 }),
  /** `POST /me/reauth`: 5 attempts per 10 minutes per session (default). */
  reauthSession: defineLimit({ mechanism: "d1", name: "reauth", limit: 5, window: { kind: "fixed", seconds: 600 } }),
};

export function ipKey(request: Request): string {
  return ipBucket(clientIp(request));
}

export function limitSetup(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.setup, ipKey(request));
}

export function limitPasskeyIp(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.passkeyIp, ipKey(request));
}

export function limitReauth(ctx: CoreContext, sessionId: string): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.reauthSession, sessionId);
}

/**
 * better-auth's `rateLimit.customStorage`: one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * on `rate_counters` (scope `better_auth`, fixed windows). Concurrent calls can't over-admit: a
 * refused call isn't counted, and the counter only moves while under the limit.
 */
export async function consumeRateLimit(
  db: D1Database,
  key: string,
  rule: { window: number; max: number },
  now = Date.now(),
): Promise<{ allowed: boolean; retryAfter: number | null }> {
  const size = Math.max(1, rule.window) * 1000;
  const start = Math.floor(now / size) * size;
  const row = expectOk(
    await new Database(db).first<{ count: number }>(
      `INSERT INTO rate_counters (scope, key, window_start, count) VALUES ('better_auth', ?, ?, 1)
       ON CONFLICT (scope, key, window_start) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
      key,
      start,
      rule.max,
    ),
  );
  if (row) return { allowed: true, retryAfter: null };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((start + size - now) / 1000)) };
}
