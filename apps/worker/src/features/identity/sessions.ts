import {
  apiError,
  err,
  ok,
  userStatusSchema,
  workspaceRoleSchema,
  type ApiError,
  type DeviceSession,
  type Result,
} from "@officebox/shared";
import { auditStatement } from "../../core/audit";
import type { AuthContext, CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { ulid } from "../../core/ids";
import { signAccessToken, verifyAccessToken } from "./access-token";
import { base64url, hmacSha256, timingSafeEqual } from "./crypto";
import type { DeviceInfo } from "./device";
import type { IdentitySecrets } from "./secrets";

/**
 * Sessions (Identity §4.5, TDD §3.1, §8.1).
 *
 * - **Access token** (`ob_session`): signed, 15 minutes (`access-token.ts`).
 * - **Refresh token** (`ob_refresh`): `<sessionId>.<32 random bytes>`, stored only as
 *   `HMAC(TOKEN_HASH_KEY, token)`. Every refresh **rotates** it. The successor is derived from the
 *   presented token, `HMAC(TOKEN_HASH_KEY, "refresh-next:" + sessionId + ":" + token)`, so two tabs
 *   that refresh with the same token within the **30-second grace window** both get the **same
 *   successor** without storing it. Presenting any other token for the session (an older one, or the
 *   previous one after the grace window) is **reuse**: the session is revoked and audited.
 * - **Sliding expiry:** a session expires 30 days after its last refresh.
 * - **Every authenticated request** checks the session row, the user's `session_epoch` and status.
 *   The check is cached per isolate for at most 60 seconds **(default)**, so a revoked session or a
 *   disabled member loses access within a minute. Revocations made in this isolate clear the cache.
 * - **Sign out everywhere** bumps `users.session_epoch`, which invalidates every session at once.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_GRACE_MS = 30_000;
export const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX_ENTRIES = 5_000;
const REFRESH_COOKIE_PATTERN = /^([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{43})$/;
const UNAUTHENTICATED: ApiError = apiError("unauthenticated", "Sign in to continue.");

export interface IssuedSession {
  userId: string;
  sessionId: string;
  accessToken: string;
  /** The `ob_refresh` cookie value. */
  refreshToken: string;
}

async function refreshHash(secrets: IdentitySecrets, token: string): Promise<string> {
  return base64url(await hmacSha256(secrets.tokenHashKey, `refresh:${token}`));
}

async function successorOf(secrets: IdentitySecrets, sessionId: string, token: string): Promise<string> {
  return base64url(await hmacSha256(secrets.tokenHashKey, `refresh-next:${sessionId}:${token}`));
}

const encoder = new TextEncoder();
function sameText(a: string | null, b: string): boolean {
  return a !== null && timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

async function accessTokenFor(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  userId: string,
  sessionId: string,
  epoch: number,
): Promise<string> {
  const key = secrets.sessionKeys[0];
  if (!key) throw new Error("No session signing key");
  return signAccessToken(key, { userId, sessionId, epoch }, ctx.now());
}

// ---- Per-isolate cache of session state ---------------------------------------------------------

interface SessionState {
  userId: string;
  role: string;
  status: string;
  userEpoch: number;
  sessionEpoch: number;
  revokedAt: number | null;
  expiresAt: number;
}

interface CacheEntry {
  state: SessionState | null;
  until: number;
}

const stateCaches = new WeakMap<D1Database, Map<string, CacheEntry>>();

function cacheFor(db: D1Database): Map<string, CacheEntry> {
  let cache = stateCaches.get(db);
  if (!cache) {
    cache = new Map();
    stateCaches.set(db, cache);
  }
  return cache;
}

/** Forgets cached state for one session, or for every session of a user. */
export function invalidateSessionCache(db: D1Database, target: { sessionId: string } | { userId: string }): void {
  const cache = cacheFor(db);
  if ("sessionId" in target) {
    cache.delete(target.sessionId);
    return;
  }
  for (const [id, entry] of cache) if (entry.state?.userId === target.userId) cache.delete(id);
}

/** Clears the whole cache (tests, and after changing a user's role or status in this isolate). */
export function clearSessionCache(db: D1Database): void {
  stateCaches.delete(db);
}

async function loadSessionState(ctx: CoreContext, sessionId: string): Promise<SessionState | null> {
  const cache = cacheFor(ctx.env.DB);
  const now = ctx.now();
  const hit = cache.get(sessionId);
  if (hit && hit.until > now) return hit.state;
  const row = expectOk(
    await new Database(ctx.env.DB).first<{
      user_id: string;
      role: string;
      status: string;
      user_epoch: number;
      session_epoch: number;
      revoked_at: number | null;
      expires_at: number;
    }>(
      `SELECT s.user_id, u.role, u.status, u.session_epoch AS user_epoch, s.session_epoch, s.revoked_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
      sessionId,
    ),
  );
  const state: SessionState | null = row
    ? {
        userId: row.user_id,
        role: row.role,
        status: row.status,
        userEpoch: row.user_epoch,
        sessionEpoch: row.session_epoch,
        revokedAt: row.revoked_at,
        expiresAt: row.expires_at,
      }
    : null;
  if (cache.size >= AUTH_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(sessionId, { state, until: now + AUTH_CACHE_TTL_MS });
  return state;
}

// ---- Authenticating a request ------------------------------------------------------------------

/** Checks an access token and the session behind it. `unauthenticated` for anything not valid. */
export async function authenticate(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  accessToken: string,
): Promise<Result<AuthContext, ApiError>> {
  const now = ctx.now();
  const payload = await verifyAccessToken(secrets.sessionKeys, accessToken, now);
  if (!payload) return err(UNAUTHENTICATED);
  const state = await loadSessionState(ctx, payload.sid);
  if (
    !state ||
    state.userId !== payload.uid ||
    state.revokedAt !== null ||
    state.expiresAt <= now ||
    state.status !== "active" ||
    state.userEpoch !== payload.ep ||
    state.sessionEpoch !== state.userEpoch
  ) {
    return err(UNAUTHENTICATED);
  }
  const role = workspaceRoleSchema.safeParse(state.role);
  const status = userStatusSchema.safeParse(state.status);
  if (!role.success || !status.success) {
    ctx.log.error("user row has an unknown role or status", { userId: state.userId });
    return err(UNAUTHENTICATED);
  }
  return ok({ userId: state.userId, sessionId: payload.sid, role: role.data, status: status.data });
}

// ---- Creating and refreshing -------------------------------------------------------------------

export async function createSession(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  user: { id: string; sessionEpoch: number },
  device: DeviceInfo,
): Promise<IssuedSession> {
  const now = ctx.now();
  const sessionId = ulid();
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  expectOk(
    await new Database(ctx.env.DB).run(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, session_epoch, user_agent, device_label,
                             approx_location, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      user.id,
      await refreshHash(secrets, token),
      user.sessionEpoch,
      device.userAgent,
      device.deviceLabel,
      device.approxLocation,
      now,
      now,
      now + SESSION_TTL_MS,
    ),
  );
  return {
    userId: user.id,
    sessionId,
    accessToken: await accessTokenFor(ctx, secrets, user.id, sessionId, user.sessionEpoch),
    refreshToken: `${sessionId}.${token}`,
  };
}

interface RefreshRow {
  user_id: string;
  refresh_token_hash: string;
  previous_refresh_hash: string | null;
  rotated_at: number | null;
  session_epoch: number;
  expires_at: number;
  revoked_at: number | null;
  user_epoch: number;
  status: string;
}

async function loadRefreshRow(ctx: CoreContext, sessionId: string): Promise<RefreshRow | null> {
  return expectOk(
    await new Database(ctx.env.DB).first<RefreshRow>(
      `SELECT s.user_id, s.refresh_token_hash, s.previous_refresh_hash, s.rotated_at, s.session_epoch,
              s.expires_at, s.revoked_at, u.session_epoch AS user_epoch, u.status
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
      sessionId,
    ),
  );
}

function usable(row: RefreshRow, now: number): boolean {
  return (
    row.revoked_at === null && row.expires_at > now && row.session_epoch === row.user_epoch && row.status === "active"
  );
}

/**
 * Rotates a refresh token (`POST /auth/refresh`). Returns the new tokens, the same successor within the
 * grace window, or `unauthenticated` (revoking the session when the token was reused).
 */
export async function refreshSession(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  cookie: string,
): Promise<Result<IssuedSession, ApiError>> {
  const match = REFRESH_COOKIE_PATTERN.exec(cookie);
  if (!match?.[1] || !match[2]) return err(UNAUTHENTICATED);
  const [, sessionId, token] = match;
  const now = ctx.now();
  let row = await loadRefreshRow(ctx, sessionId);
  if (!row || !usable(row, now)) return err(UNAUTHENTICATED);

  const presented = await refreshHash(secrets, token);
  const successor = await successorOf(secrets, sessionId, token);
  const successorHash = await refreshHash(secrets, successor);
  const issue = async (r: RefreshRow): Promise<Result<IssuedSession, ApiError>> =>
    ok({
      userId: r.user_id,
      sessionId,
      accessToken: await accessTokenFor(ctx, secrets, r.user_id, sessionId, r.user_epoch),
      refreshToken: `${sessionId}.${successor}`,
    });

  if (sameText(row.refresh_token_hash, presented)) {
    // Compare-and-set on the current hash: of two concurrent rotations, one wins and the other falls
    // through to the grace path below with the row as the winner left it.
    const meta = expectOk(
      await new Database(ctx.env.DB).run(
        `UPDATE sessions
            SET previous_refresh_hash = refresh_token_hash, refresh_token_hash = ?, rotated_at = ?,
                last_seen_at = ?, expires_at = ?
          WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
        successorHash,
        now,
        now,
        now + SESSION_TTL_MS,
        sessionId,
        presented,
      ),
    );
    if (meta.changes === 1) return issue(row);
    row = await loadRefreshRow(ctx, sessionId);
    if (!row || !usable(row, now)) return err(UNAUTHENTICATED);
  }

  const withinGrace = row.rotated_at !== null && now - row.rotated_at <= REFRESH_GRACE_MS;
  if (
    withinGrace &&
    sameText(row.previous_refresh_hash, presented) &&
    sameText(row.refresh_token_hash, successorHash)
  ) {
    return issue(row);
  }

  // Reuse: an old refresh token came back. Someone else may hold this session's tokens.
  const db = new Database(ctx.env.DB);
  expectOk(
    await db.batchRun([
      db.statement("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", now, sessionId),
      await auditStatement(
        ctx,
        {
          action: "session.refresh_reuse",
          actor: null,
          target: { type: "session", id: sessionId },
          metadata: { userId: row.user_id },
        },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  invalidateSessionCache(ctx.env.DB, { sessionId });
  ctx.log.warn("refresh token reuse detected; session revoked", { sessionId, userId: row.user_id });
  return err(UNAUTHENTICATED);
}

// ---- Signing out -------------------------------------------------------------------------------

/**
 * The session a refresh cookie belongs to, if its token is the session's current or previous one.
 * Used by sign-out when the access token has already expired. Never revokes on a mismatch.
 */
export async function sessionOfRefreshCookie(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  cookie: string | undefined,
): Promise<string | null> {
  const match = cookie ? REFRESH_COOKIE_PATTERN.exec(cookie) : null;
  if (!match?.[1] || !match[2]) return null;
  const row = await loadRefreshRow(ctx, match[1]);
  if (!row) return null;
  const presented = await refreshHash(secrets, match[2]);
  return sameText(row.refresh_token_hash, presented) || sameText(row.previous_refresh_hash, presented)
    ? match[1]
    : null;
}

/** Revokes one session, if it belongs to `userId` (when given). Returns whether a row changed. */
export async function revokeSession(ctx: CoreContext, sessionId: string, userId?: string): Promise<boolean> {
  const db = new Database(ctx.env.DB);
  const meta = expectOk(
    userId === undefined
      ? await db.run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", ctx.now(), sessionId)
      : await db.run(
          "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
          ctx.now(),
          sessionId,
          userId,
        ),
  );
  invalidateSessionCache(ctx.env.DB, { sessionId });
  return meta.changes > 0;
}

/** Signs out every other session of the user, keeping `currentSessionId`. Audited. */
export async function signOutOtherSessions(
  ctx: CoreContext,
  userId: string,
  currentSessionId: string,
): Promise<number> {
  const db = new Database(ctx.env.DB);
  const [update] = expectOk(
    await db.batchRun([
      db.statement(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL",
        ctx.now(),
        userId,
        currentSessionId,
      ),
      await auditStatement(
        ctx,
        { action: "session.sign_out_others", actor: userId, target: { type: "user", id: userId } },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  invalidateSessionCache(ctx.env.DB, { userId });
  return update?.changes ?? 0;
}

/** Signs the user out of every session, this one included, by bumping `session_epoch`. Audited. */
export async function signOutEverywhere(ctx: CoreContext, userId: string, actorId: string): Promise<void> {
  const db = new Database(ctx.env.DB);
  const now = ctx.now();
  expectOk(
    await db.batchRun([
      db.statement("UPDATE users SET session_epoch = session_epoch + 1, updated_at = ? WHERE id = ?", now, userId),
      db.statement("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", now, userId),
      await auditStatement(ctx, {
        action: "session.sign_out_everywhere",
        actor: actorId,
        target: { type: "user", id: userId },
      }),
    ]),
  );
  invalidateSessionCache(ctx.env.DB, { userId });
}

// ---- My devices --------------------------------------------------------------------------------

/** The owner of an active session, for the permission check before revoking it. */
export async function activeSessionOwner(ctx: CoreContext, sessionId: string): Promise<string | null> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ user_id: string }>(
      "SELECT user_id FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
      sessionId,
      ctx.now(),
    ),
  );
  return row?.user_id ?? null;
}

export async function listSessions(
  ctx: CoreContext,
  userId: string,
  currentSessionId: string,
): Promise<DeviceSession[]> {
  const rows = expectOk(
    await new Database(ctx.env.DB).all<{
      id: string;
      device_label: string | null;
      approx_location: string | null;
      created_at: number;
      last_seen_at: number;
    }>(
      `SELECT s.id, s.device_label, s.approx_location, s.created_at, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND s.session_epoch = u.session_epoch
        ORDER BY s.last_seen_at DESC, s.id DESC
        LIMIT 200`,
      userId,
      ctx.now(),
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    deviceLabel: r.device_label,
    approxLocation: r.approx_location,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    current: r.id === currentSessionId,
  }));
}

// ---- Housekeeping ------------------------------------------------------------------------------

/** How long a revoked session row is kept (for support and the audit trail) before it's deleted. */
export const REVOKED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes expired, revoked and epoch-invalidated sessions (daily), taking their device label and
 * approximate location with them (Identity §4.5).
 */
export async function pruneSessions(ctx: CoreContext): Promise<number> {
  const now = ctx.now();
  const meta = expectOk(
    await new Database(ctx.env.DB).run(
      `DELETE FROM sessions
        WHERE expires_at <= ?
           OR (revoked_at IS NOT NULL AND revoked_at < ?)
           OR session_epoch < (SELECT u.session_epoch FROM users u WHERE u.id = sessions.user_id)`,
      now,
      now - REVOKED_SESSION_RETENTION_MS,
    ),
  );
  return meta.changes;
}
