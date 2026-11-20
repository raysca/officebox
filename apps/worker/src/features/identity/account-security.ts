import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { closeAllUserConnections } from "./revocation";

/**
 * Shared steps of the M1c recovery, email-change and domain-move flows (Identity §4.4, §4.6, §4.11):
 * signing people out (and closing their live sockets) and revoking their outstanding tokens.
 *
 * **Sessions** are deleted with our own SQL, not better-auth's revoke (which needs the person's own
 * session headers), so better-auth's `session.delete.after` hook doesn't run. Every revocation here
 * therefore closes the person's sockets itself through the M2a revocation path (`closeAllUserConnections`:
 * `UserHub.closeConnections` plus the D1 room fallback), as Identity §4.5 requires of every revocation.
 */

/** Auth-token kinds that are links or tickets someone could still use. */
export type RevocableTokenKind = "recovery" | "email_change" | "passkey_enrol" | "domain_move";

/**
 * Statements that revoke a person's pending magic links (by user and by normalised email, so a link
 * issued to the address before it changed is caught too) and their unused tokens of `kinds`.
 */
export function revokeLinksStatements(
  database: Database,
  input: { userId: string; emailNormalised: string | null; kinds: readonly RevocableTokenKind[]; now: number },
): D1PreparedStatement[] {
  const statements = [
    database.statement(
      `UPDATE magic_link_issues SET revoked_at = ?1
        WHERE (user_id = ?2 OR email_normalised = ?3) AND consumed_at IS NULL AND revoked_at IS NULL`,
      input.now,
      input.userId,
      input.emailNormalised ?? "",
    ),
  ];
  if (input.kinds.length > 0) {
    statements.push(
      database.statement(
        `UPDATE auth_tokens SET revoked_at = ?1
          WHERE user_id = ?2 AND used_at IS NULL AND revoked_at IS NULL
            AND kind IN (SELECT value FROM json_each(?3))`,
        input.now,
        input.userId,
        JSON.stringify(input.kinds),
      ),
    );
  }
  return statements;
}

async function closeSockets(ctx: CoreContext, userIds: Iterable<string>): Promise<void> {
  const unique = [...new Set(userIds)];
  const results = await Promise.allSettled(
    unique.map((userId) => closeAllUserConnections(ctx.env, ctx.log, userId, "session_revoked")),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) ctx.log.warn("closing sockets after a revocation failed for some people", { failed });
}

/**
 * Signs a person out of every session (except `exceptSessionId`) and closes their live sockets within
 * seconds. Returns how many sessions were revoked.
 */
export async function revokeUserSessions(ctx: CoreContext, userId: string, exceptSessionId?: string): Promise<number> {
  const rows = expectOk(
    await new Database(ctx.env.DB).all<{ id: string }>(
      "DELETE FROM sessions WHERE user_id = ? AND id != ? RETURNING id",
      userId,
      exceptSessionId ?? "",
    ),
  );
  // Sockets are closed even when no row was deleted: an expired session's sockets may still be open.
  await closeSockets(ctx, [userId]);
  return rows.length;
}

/** Signs everyone out (except one session) and closes every affected person's sockets: a domain move. */
export async function revokeAllSessions(ctx: CoreContext, exceptSessionId?: string): Promise<number> {
  const rows = expectOk(
    await new Database(ctx.env.DB).all<{ user_id: string }>(
      "DELETE FROM sessions WHERE id != ? RETURNING user_id",
      exceptSessionId ?? "",
    ),
  );
  await closeSockets(
    ctx,
    rows.map((r) => r.user_id),
  );
  return rows.length;
}

/** A person's display name for notices and emails, or a neutral fallback. */
export async function displayNameOf(db: D1Database, userId: string | null, fallback: string): Promise<string> {
  if (!userId) return fallback;
  const row = expectOk(
    await new Database(db).first<{ display_name: string }>("SELECT display_name FROM users WHERE id = ?", userId),
  );
  return row?.display_name ?? fallback;
}
