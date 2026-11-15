import { passkeyCreatedViaSchema, type PasskeyCreatedVia } from "@officebox/shared";
import { z } from "zod";
import { Database, expectOk } from "../../core/db";
import { randomToken, tokenHash } from "./crypto";

/**
 * Passkey **enrolment tickets** (Identity §4.4; TDD §8.1; M1a-0 spike, workaround 6).
 *
 * Setup (and, later, invitation acceptance, recovery links and the domain move) registers a passkey
 * before the person has a session. A ticket is:
 * - 32 random bytes, stored as HMAC(TOKEN_HASH_KEY) in `auth_tokens` with `kind = 'passkey_enrol'`,
 *   bound to one user, valid for 15 minutes, single-use;
 * - carried **only** in an `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` cookie with `Path=/`,
 *   never in a JSON body; only the passkey registration routes read it;
 * - **bound to the registration challenge** when options are generated (`payload.challenge`), so a
 *   challenge from another ticket or session is refused;
 * - **consumed at registration verify** (never at options) by compare-and-set, before better-auth
 *   writes anything, so two concurrent verifies register at most one passkey.
 */

export const ENROL_COOKIE = "__Host-officebox-enrol";
export const ENROL_TTL_MS = 15 * 60 * 1000;

const payloadSchema = z.object({
  via: passkeyCreatedViaSchema,
  /** The setup claim nonce, when the ticket was issued by setup. */
  claim: z.string().nullable().default(null),
  challenge: z.string().optional(),
});
export type TicketPayload = z.infer<typeof payloadSchema>;

function parsePayload(raw: string | null): TicketPayload | null {
  if (!raw) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface IssuedTicket {
  /** The raw ticket: goes only into the cookie. */
  token: string;
  expiresAt: number;
}

/** Issues a ticket for `userId`, revoking that user's other outstanding tickets. */
export async function issueTicket(
  db: D1Database,
  key: string,
  userId: string,
  via: PasskeyCreatedVia,
  claim: string | null,
  now: number,
): Promise<IssuedTicket> {
  const token = randomToken(32);
  const hash = await tokenHash(key, token);
  const expiresAt = now + ENROL_TTL_MS;
  const database = new Database(db);
  expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE auth_tokens SET revoked_at = ?
          WHERE user_id = ? AND kind = 'passkey_enrol' AND used_at IS NULL AND revoked_at IS NULL`,
        now,
        userId,
      ),
      database.statement(
        `INSERT INTO auth_tokens (token_hash, user_id, kind, payload, expires_at, created_at)
         VALUES (?, ?, 'passkey_enrol', ?, ?, ?)`,
        hash,
        userId,
        JSON.stringify({ via, claim }),
        expiresAt,
        now,
      ),
    ]),
  );
  return { token, expiresAt };
}

/** The `Set-Cookie` value carrying a ticket. */
export function ticketCookie(ticket: IssuedTicket, now: number): string {
  const maxAge = Math.max(0, Math.floor((ticket.expiresAt - now) / 1000));
  return `${ENROL_COOKIE}=${ticket.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Clears the ticket cookie (after a registration consumed it). */
export const CLEAR_TICKET_COOKIE = `${ENROL_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** Reads the ticket from a Cookie header. */
export function readTicketCookie(headers: Headers | undefined): string | null {
  const raw = headers?.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ENROL_COOKIE) {
      const value = rest.join("=");
      return value === "" ? null : value;
    }
  }
  return null;
}

export interface ValidTicket {
  userId: string;
  email: string;
  displayName: string;
  payload: TicketPayload;
}

/** A ticket that is unused, unrevoked and unexpired, with its user; null otherwise. */
export async function findValidTicket(db: D1Database, hash: string, now: number): Promise<ValidTicket | null> {
  const row = expectOk(
    await new Database(db).first<{ user_id: string; email: string; display_name: string; payload: string | null }>(
      `SELECT t.user_id, u.email, u.display_name, t.payload
         FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.kind = 'passkey_enrol' AND t.used_at IS NULL AND t.revoked_at IS NULL
          AND t.expires_at > ? AND u.status = 'active'`,
      hash,
      now,
    ),
  );
  const payload = parsePayload(row?.payload ?? null);
  if (!row || !payload) return null;
  return { userId: row.user_id, email: row.email, displayName: row.display_name, payload };
}

/** Binds a valid ticket to the challenge just generated for it (the latest options win). */
export async function bindChallenge(db: D1Database, hash: string, challenge: string, now: number): Promise<boolean> {
  const meta = expectOk(
    await new Database(db).run(
      `UPDATE auth_tokens SET payload = json_set(coalesce(payload, '{}'), '$.challenge', ?)
        WHERE token_hash = ? AND kind = 'passkey_enrol' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      challenge,
      hash,
      now,
    ),
  );
  return meta.changes === 1;
}

/**
 * Consumes a ticket at registration verify: one compare-and-set that also checks the user and the
 * bound challenge. Returns the payload for the winner, null for everyone else.
 */
export async function consumeTicket(
  db: D1Database,
  hash: string,
  userId: string,
  challenge: string,
  now: number,
): Promise<TicketPayload | null> {
  const row = expectOk(
    await new Database(db).first<{ payload: string | null }>(
      `UPDATE auth_tokens SET used_at = ?1
        WHERE token_hash = ?2 AND user_id = ?3 AND kind = 'passkey_enrol'
          AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?1
          AND json_extract(payload, '$.challenge') = ?4
          AND EXISTS (SELECT 1 FROM users WHERE id = ?3 AND status = 'active')
        RETURNING payload`,
      now,
      hash,
      userId,
      challenge,
    ),
  );
  return row ? parsePayload(row.payload) : null;
}
