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
  /** `GET /setup` (status, and the generated token on first visit): 20 per minute per IP (default). */
  setupStatus: defineLimit({
    mechanism: "binding",
    name: "setup_status",
    binding: "PASSKEY_RATE_LIMITER",
    periodSeconds: 60,
  }),
  /** Passkey sign-in and registration (options and verify), and step-up attempts: 20 per minute per IP. */
  passkeyIp: defineLimit({ mechanism: "binding", name: "passkey", binding: "PASSKEY_RATE_LIMITER", periodSeconds: 60 }),
  /** Invitation lookup and acceptance: 5 per minute per IP (Platform §8). */
  invitation: defineLimit({
    mechanism: "binding",
    name: "invitation",
    binding: "AUTH_RATE_LIMITER",
    periodSeconds: 60,
  }),
  /** Recovery-link lookup and use: 5 per minute per IP (Platform §8; M1c). */
  recovery: defineLimit({ mechanism: "binding", name: "recovery", binding: "AUTH_RATE_LIMITER", periodSeconds: 60 }),
  /** Owner recovery with `RECOVERY_TOKEN` (`POST /recover`): 5 per minute per IP (Platform §8; M1c). */
  ownerRecovery: defineLimit({
    mechanism: "binding",
    name: "owner_recovery",
    binding: "AUTH_RATE_LIMITER",
    periodSeconds: 60,
  }),
  /** Email-change confirmation lookup and POST: 5 per minute per IP (default, as the other links; M1c). */
  emailConfirm: defineLimit({
    mechanism: "binding",
    name: "email_confirm",
    binding: "AUTH_RATE_LIMITER",
    periodSeconds: 60,
  }),
  /** The domain move link's POST on the new origin: 5 per minute per IP (default, as the other links; M1c). */
  domainComplete: defineLimit({
    mechanism: "binding",
    name: "domain_complete",
    binding: "AUTH_RATE_LIMITER",
    periodSeconds: 60,
  }),
  /** `GET /status/public`: 60 per minute per IP (Platform §8). */
  publicStatus: defineLimit({
    mechanism: "binding",
    name: "public_status",
    binding: "STATUS_RATE_LIMITER",
    periodSeconds: 60,
  }),
  /** `POST /me/reauth`: 5 attempts per 10 minutes per session (default). */
  reauthSession: defineLimit({ mechanism: "d1", name: "reauth", limit: 5, window: { kind: "fixed", seconds: 600 } }),
};

export function ipKey(request: Request): string {
  return ipBucket(clientIp(request));
}

export function limitSetup(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.setup, ipKey(request));
}

export function limitSetupStatus(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.setupStatus, ipKey(request));
}

export function limitPasskeyIp(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.passkeyIp, ipKey(request));
}

export function limitInvitation(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.invitation, ipKey(request));
}

export function limitRecovery(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.recovery, ipKey(request));
}

export function limitOwnerRecovery(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.ownerRecovery, ipKey(request));
}

export function limitEmailConfirm(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.emailConfirm, ipKey(request));
}

export function limitDomainComplete(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.domainComplete, ipKey(request));
}

export function limitPublicStatus(ctx: CoreContext, request: Request): Promise<Result<void, ApiError>> {
  return checkLimit(ctx, IDENTITY_LIMITS.publicStatus, ipKey(request));
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
