import { ULID_PATTERN } from "@officebox/shared";
import { z } from "zod";
import { base64url, fromBase64url, hmacSha256, timingSafeEqual } from "./crypto";

/**
 * Access tokens: the `ob_session` cookie (TDD §3.1). A short-lived (15-minute) token carrying the user
 * ID, session ID and `session_epoch`, signed with HMAC-SHA-256 under `SESSION_SIGNING_KEY`:
 *
 *   <base64url(JSON payload)>.<base64url(HMAC(key, "ob_session.v1." + payload part))>
 *
 * Verification accepts the current key or, during a rotation, the previous one. The token alone never
 * authorises anything: every request also checks the session row and the user's epoch and status
 * (`sessions.ts`), so revocation doesn't wait for expiry.
 */

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const CONTEXT = "ob_session.v1.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const payloadSchema = z.strictObject({
  v: z.literal(1),
  uid: z.string().regex(ULID_PATTERN),
  sid: z.string().regex(ULID_PATTERN),
  ep: z.number().int().nonnegative(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type AccessTokenPayload = z.infer<typeof payloadSchema>;

export async function signAccessToken(
  key: string,
  claims: { userId: string; sessionId: string; epoch: number },
  now: number,
): Promise<string> {
  const payload: AccessTokenPayload = {
    v: 1,
    uid: claims.userId,
    sid: claims.sessionId,
    ep: claims.epoch,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_MS,
  };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = base64url(await hmacSha256(key, CONTEXT + body));
  return `${body}.${signature}`;
}

/** The payload of a well-signed, unexpired token, or null. Never throws. */
export async function verifyAccessToken(
  keys: readonly string[],
  token: string,
  now: number,
): Promise<AccessTokenPayload | null> {
  if (token.length > 1024) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const presented = fromBase64url(signature);
  if (!presented) return null;
  let signed = false;
  for (const key of keys) {
    if (timingSafeEqual(await hmacSha256(key, CONTEXT + body), presented)) signed = true;
  }
  if (!signed) return null;
  const bytes = fromBase64url(body);
  if (!bytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success || parsed.data.exp <= now) return null;
  return parsed.data;
}
