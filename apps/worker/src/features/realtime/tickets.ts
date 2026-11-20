import { WS_TICKET_TTL_MS } from "@officebox/shared";
import { Database, expectOk } from "../../core/db";
import { tokenHashKeyOrNull } from "../../core/keys";
import type { Logger } from "../../core/log";
import type { Env } from "../../env";
import { randomToken, tokenHash } from "../identity/crypto";

/**
 * Short-lived, single-use WebSocket upgrade tickets (`ws_tickets`, TDD §3.1, §4.2).
 *
 * - 32 random bytes, stored only as `HMAC-SHA256(TOKEN_HASH_KEY, raw)` in `ws_tickets.token_hash`.
 * - Valid for 30 seconds (`WS_TICKET_TTL_MS`).
 * - Bound to a specific `target` (`"hub"` or `"<kind>:<roomId>"`) and the issuing `user_id` + `session_id`.
 * - Consumed atomically via compare-and-set (`UPDATE ws_tickets SET used_at = ? WHERE ... RETURNING ...`)
 *   while checking that both the user (`status = 'active'`) and the session (`expires_at > now`) are
 *   still valid.
 */

export interface IssuedWsTicket {
  ticket: string;
  expiresAt: number;
  target: string;
}

export async function issueWsTicket(
  env: Env,
  log: Logger,
  userId: string,
  sessionId: string,
  target: string,
  now: number,
): Promise<IssuedWsTicket | null> {
  const key = await tokenHashKeyOrNull(env, log);
  if (!key) return null;
  const ticket = randomToken(32);
  const hash = await tokenHash(key, ticket);
  const expiresAt = now + WS_TICKET_TTL_MS;
  const db = new Database(env.DB);
  expectOk(
    await db.run(
      `INSERT INTO ws_tickets (token_hash, user_id, session_id, target, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      hash,
      userId,
      sessionId,
      target,
      expiresAt,
      now,
    ),
  );
  return { ticket, expiresAt, target };
}

export interface ConsumedWsTicket {
  userId: string;
  sessionId: string;
  target: string;
}

/**
 * Consumes a single-use WebSocket upgrade ticket for `expectedTarget` at `now`.
 * Returns `null` if the ticket is unknown, expired, already used, for a different target, or if the
 * user/session is no longer active.
 */
export async function consumeWsTicket(
  env: Env,
  log: Logger,
  rawTicket: string,
  expectedTarget: string,
  now: number,
): Promise<ConsumedWsTicket | null> {
  if (!rawTicket || rawTicket.length > 256) return null;
  const key = await tokenHashKeyOrNull(env, log);
  if (!key) return null;
  const hash = await tokenHash(key, rawTicket);
  const db = new Database(env.DB);
  const row = expectOk(
    await db.first<{ user_id: string; session_id: string | null; target: string }>(
      `UPDATE ws_tickets
          SET used_at = ?1
        WHERE token_hash = ?2
          AND target = ?3
          AND used_at IS NULL
          AND expires_at > ?1
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = ws_tickets.user_id AND u.status = 'active')
          AND (
            ws_tickets.session_id IS NULL
            OR EXISTS (
              SELECT 1 FROM sessions s
               WHERE s.id = ws_tickets.session_id
                 AND s.user_id = ws_tickets.user_id
                 AND s.expires_at > ?1
            )
          )
        RETURNING user_id, session_id, target`,
      now,
      hash,
      expectedTarget,
    ),
  );
  if (!row || !row.session_id) return null;
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    target: row.target,
  };
}
