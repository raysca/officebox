import {
  apiError,
  err,
  ok,
  type ApiError,
  type MemberChangeResult,
  type MemberDeletedResult,
  type PermissionCheck,
  type Result,
  type WorkspaceRole,
} from "@officebox/shared";
import { auditStatement, hashPersonal } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk, type SqlValue } from "../../core/db";
import { ulid } from "../../core/ids";
import { displayNameOf } from "./account-security";
import { deleteAvatarObjects } from "./avatar";
import { emailSecurityNotices } from "./notice-email";
import { noticeStatement } from "./notices";
import { closeAllUserConnections } from "./revocation";

/**
 * Members administration (Identity §4.11; Permissions §4.6, §6; Platform §3 Member lifecycle, §3.1 erase
 * list; M1e): role changes, disable and re-enable, sign out all sessions, and delete (anonymise).
 *
 * The route authorizes each action with the permission engine (`authorizeWithFacts`), which returns the
 * facts it decided on. **Every write here is conditional on those facts** (the target's role and status,
 * the actor's role and status, and for an owner, another active owner remaining), so:
 * - two owners demoting or disabling each other at once can never leave zero active owners: D1 runs
 *   each statement atomically and in order, and the second write sees the first's result (Admin §5.3);
 * - an admin who was allowed to act on a member can't end up acting on someone promoted meanwhile;
 * - an actor demoted or disabled meanwhile acts on nobody.
 * A write that matches nothing is explained by re-reading (`explainNoop`): `last_owner`, a changed
 * target (`member_changed`, try again), or an actor who may no longer act.
 *
 * **Disabling** revokes every session (rows deleted), closes every live socket (`4401`) through the
 * UserHub room registry and the Worker fallback, and revokes outstanding links and tickets (magic links,
 * recovery and email-change links, enrolment tickets, WebSocket tickets), so a disabled member can't
 * sign in, use a link or open a socket (Platform §3; Identity §4.5). Each of those paths also checks
 * `status = 'active'` itself.
 *
 * **Deleting** marks the account `deleted` and signs it out in one batch, then runs the idempotent
 * erase ({@link eraseDeletedMember}, Platform §3.1), which the hourly repair job re-runs for any deleted
 * account whose erase didn't finish (R2 down, for example). The user row stays (anonymised), so every
 * reference to it stays valid; its handle is released and held for 30 days (Identity §4.8).
 */

type MemberCheck = Extract<PermissionCheck, { target: unknown }>;

interface Snapshot {
  actorId: string;
  actorRole: WorkspaceRole;
  targetId: string;
  targetRole: WorkspaceRole;
  targetStatus: string;
}

function snapshotOf(actorId: string, actorRole: WorkspaceRole, check: MemberCheck): Snapshot {
  return {
    actorId,
    actorRole,
    targetId: check.target.userId,
    targetRole: check.target.role,
    targetStatus: check.target.status,
  };
}

/**
 * The SQL guard for a write on `users` (the target row, unqualified columns): the target and the actor
 * are still as the engine saw them. Returns the condition and its parameters, in order.
 */
function stillAsDecided(snap: Snapshot): { sql: string; params: SqlValue[] } {
  return {
    sql: `role = ? AND status = ?
      AND EXISTS (SELECT 1 FROM users a WHERE a.id = ? AND a.status = 'active' AND a.role = ?)`,
    params: [snap.targetRole, snap.targetStatus, snap.actorId, snap.actorRole],
  };
}

/** SQL: another active owner remains besides the target row (unqualified `id`). */
const ANOTHER_OWNER =
  "(SELECT count(*) FROM users o WHERE o.role = 'owner' AND o.status = 'active' AND o.id != users.id) >= 1";

const LAST_OWNER: ApiError = apiError("forbidden", "The workspace must keep at least one active owner.", {
  reason: "last_owner",
});

/** Why a guarded write matched nothing, from the state as it is now. */
async function explainNoop(ctx: CoreContext, snap: Snapshot, removesOwner: boolean): Promise<ApiError> {
  const database = new Database(ctx.env.DB);
  const [actor, target, owners] = await Promise.all([
    database.first<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", snap.actorId),
    database.first<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", snap.targetId),
    database.first<{ n: number }>(
      "SELECT count(*) AS n FROM users WHERE role = 'owner' AND status = 'active' AND id != ?",
      snap.targetId,
    ),
  ]);
  const a = expectOk(actor);
  const t = expectOk(target);
  if (!t || t.status === "deleted") return apiError("not_found", "No such member.");
  if (!a || a.status !== "active" || a.role !== snap.actorRole) {
    return apiError("forbidden", "Your role changed. Reload and try again.", { reason: "not_permitted" });
  }
  if (t.role !== snap.targetRole || t.status !== snap.targetStatus) {
    return apiError("conflict", "This person's account changed at the same time. Reload and try again.", {
      reason: "member_changed",
    });
  }
  if (removesOwner && (expectOk(owners)?.n ?? 0) < 1) return LAST_OWNER;
  return apiError("conflict", "Nothing changed. Reload and try again.", { reason: "member_changed" });
}

function activeOrDisabled(status: string): "active" | "disabled" {
  return status === "disabled" ? "disabled" : "active";
}

/**
 * Statements revoking every link and ticket a person could still use (Platform §3: a disabled member
 * can't use links or tickets), each only while the person isn't active, so they never run for someone
 * whose disable didn't apply.
 */
function revokeEverythingStatements(database: Database, userId: string, now: number): D1PreparedStatement[] {
  const inactive = "EXISTS (SELECT 1 FROM users WHERE id = ?2 AND status IN ('disabled', 'deleted'))";
  return [
    database.statement(
      `UPDATE magic_link_issues SET revoked_at = ?1
        WHERE (user_id = ?2 OR email_normalised = (SELECT email_normalised FROM users WHERE id = ?2))
          AND consumed_at IS NULL AND revoked_at IS NULL AND ${inactive}`,
      now,
      userId,
    ),
    database.statement(
      `UPDATE auth_tokens SET revoked_at = ?1
        WHERE user_id = ?2 AND used_at IS NULL AND revoked_at IS NULL AND ${inactive}`,
      now,
      userId,
    ),
    database.statement(
      `DELETE FROM ws_tickets WHERE user_id = ?1 AND used_at IS NULL AND ${inactive.replace("?2", "?1")}`,
      userId,
    ),
    database.statement(`DELETE FROM sessions WHERE user_id = ?1 AND ${inactive.replace("?2", "?1")}`, userId),
  ];
}

/**
 * Statements revoking the pending invitations a person sent, once they're disabled or deleted (M1e,
 * **default**): an invitation shouldn't outlive its inviter's access. Each is audited as
 * `invitation.revoked` (the acting admin, with a `reason`), and a last catch-all revokes any sent after
 * the read. Every statement is gated on the change's own audit entry, written only if the guarded
 * disable or delete applied, so a refused change revokes and audits nothing.
 */
export async function revokeSentInvitationsStatements(
  ctx: CoreContext,
  database: Database,
  actorId: string,
  inviterId: string,
  now: number,
  reason: "inviter_disabled" | "inviter_deleted",
  /** The ID of the disable's or delete's audit entry: written only if that change applied. */
  appliedAuditId: string,
): Promise<D1PreparedStatement[]> {
  const pending = "accepted_at IS NULL AND accepted_attempt_id IS NULL AND revoked_at IS NULL";
  const applied = "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)";
  const rows = expectOk(
    await database.all<{ id: string }>(`SELECT id FROM invitations WHERE invited_by = ? AND ${pending}`, inviterId),
  );
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    statements.push(
      database.statement(
        `UPDATE invitations SET revoked_at = ? WHERE id = ? AND ${pending} AND ${applied}`,
        now,
        row.id,
        appliedAuditId,
      ),
      await auditStatement(
        ctx,
        {
          action: "invitation.revoked",
          actor: actorId,
          target: { type: "invitation", id: row.id },
          metadata: { reason },
        },
        { onlyIfPreviousChanged: true },
      ),
    );
  }
  statements.push(
    database.statement(
      `UPDATE invitations SET revoked_at = ? WHERE invited_by = ? AND ${pending} AND ${applied}`,
      now,
      inviterId,
      appliedAuditId,
    ),
    await auditStatement(
      ctx,
      {
        action: "invitation.revoked",
        actor: actorId,
        target: { type: "user", id: inviterId },
        metadata: { reason, sentLater: true },
      },
      { onlyIfPreviousChanged: true },
    ),
  );
  return statements;
}

/** Closes a person's live sockets; a failure is logged (the UserHub's recheck closes them anyway). */
async function closeSockets(ctx: CoreContext, userId: string): Promise<void> {
  try {
    await closeAllUserConnections(ctx.env, ctx.log, userId, "user_disabled");
  } catch (error) {
    ctx.log.error("closing a disabled member's sockets failed", { userId, error });
  }
}

/** `PATCH /admin/members/:id { status: "disabled" }`, authorized as `member.disable`. */
export async function disableMember(
  ctx: CoreContext,
  actor: { userId: string; role: WorkspaceRole },
  check: MemberCheck,
): Promise<Result<MemberChangeResult, ApiError>> {
  const snap = snapshotOf(actor.userId, actor.role, check);
  if (snap.targetStatus === "disabled") {
    return ok({ id: snap.targetId, role: snap.targetRole, status: "disabled", changed: false });
  }
  const now = ctx.now();
  const auditId = ulid();
  const database = new Database(ctx.env.DB);
  const guard = stillAsDecided(snap);
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE users SET status = 'disabled', updated_at = ?
          WHERE id = ? AND ${guard.sql} AND (role != 'owner' OR ${ANOTHER_OWNER})`,
        now,
        snap.targetId,
        ...guard.params,
      ),
      await auditStatement(
        ctx,
        {
          action: "member.disabled",
          actor: actor.userId,
          target: { type: "user", id: snap.targetId },
          metadata: { role: snap.targetRole },
        },
        { onlyIfPreviousChanged: true, id: auditId },
      ),
      ...revokeEverythingStatements(database, snap.targetId, now),
      ...(await revokeSentInvitationsStatements(
        ctx,
        database,
        actor.userId,
        snap.targetId,
        now,
        "inviter_disabled",
        auditId,
      )),
    ]),
  );
  if ((result[0]?.changes ?? 0) !== 1) return err(await explainNoop(ctx, snap, snap.targetRole === "owner"));
  await closeSockets(ctx, snap.targetId);
  return ok({ id: snap.targetId, role: snap.targetRole, status: "disabled", changed: true });
}

/** `PATCH /admin/members/:id { status: "active" }`, authorized as `member.enable`. */
export async function enableMember(
  ctx: CoreContext,
  actor: { userId: string; role: WorkspaceRole },
  check: MemberCheck,
): Promise<Result<MemberChangeResult, ApiError>> {
  const snap = snapshotOf(actor.userId, actor.role, check);
  if (snap.targetStatus === "active") {
    return ok({ id: snap.targetId, role: snap.targetRole, status: "active", changed: false });
  }
  const now = ctx.now();
  const database = new Database(ctx.env.DB);
  const guard = stillAsDecided(snap);
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE users SET status = 'active', updated_at = ? WHERE id = ? AND ${guard.sql}`,
        now,
        snap.targetId,
        ...guard.params,
      ),
      await auditStatement(
        ctx,
        {
          action: "member.enabled",
          actor: actor.userId,
          target: { type: "user", id: snap.targetId },
          metadata: { role: snap.targetRole },
        },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  if ((result[0]?.changes ?? 0) !== 1) return err(await explainNoop(ctx, snap, false));
  return ok({ id: snap.targetId, role: snap.targetRole, status: "active", changed: true });
}

const ROLE_ORDER: Record<WorkspaceRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/**
 * `PATCH /admin/members/:id { role }`, authorized as `member.change_role` (owners only, step-up, the
 * promotion passkey rules). The write re-checks the passkeys the promotion relied on, so a passkey
 * removed meanwhile makes it a no-op. Promoting a member revokes their pending magic links (magic links
 * are for members only); demoting an admin gives them back and keeps their passkeys (Identity §4.11).
 * The person gets a `role_changed` security notice (banner, and email when configured; Notifications §3).
 */
export async function changeMemberRole(
  ctx: CoreContext,
  actor: { userId: string; role: WorkspaceRole },
  check: Extract<PermissionCheck, { action: "member.change_role" }>,
): Promise<Result<MemberChangeResult, ApiError>> {
  const snap = snapshotOf(actor.userId, actor.role, check);
  const newRole = check.newRole;
  const status = activeOrDisabled(snap.targetStatus);
  if (newRole === snap.targetRole) return ok({ id: snap.targetId, role: newRole, status, changed: false });
  const now = ctx.now();
  const database = new Database(ctx.env.DB);
  const guard = stillAsDecided(snap);
  const promotes = ROLE_ORDER[newRole] > ROLE_ORDER[snap.targetRole];
  // The passkeys the decision relied on: one to become an admin; two to become an owner unless the
  // unconsumed RECOVERY_TOKEN satisfied the rule instead (Identity §2 "Promotion").
  const minPasskeys = !promotes ? 0 : newRole === "owner" && check.targetPasskeyCount >= 2 ? 2 : 1;
  const removesOwner = snap.targetRole === "owner";
  const actorName = await displayNameOf(ctx.env.DB, actor.userId, "An owner");
  // The notice and the magic-link revocation commit with the change: both are gated on its audit entry,
  // which is written only if the guarded UPDATE applied.
  const auditId = ulid();
  const applied = { sql: "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)", params: [auditId] };
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE users SET role = ?, updated_at = ?
          WHERE id = ? AND ${guard.sql}
            AND (role != 'owner' OR ${ANOTHER_OWNER})
            AND (SELECT count(*) FROM passkeys p WHERE p.user_id = users.id) >= ?`,
        newRole,
        now,
        snap.targetId,
        ...guard.params,
        minPasskeys,
      ),
      await auditStatement(
        ctx,
        {
          action: "member.role_changed",
          actor: actor.userId,
          target: { type: "user", id: snap.targetId },
          metadata: { from: snap.targetRole, to: newRole, promotion: promotes },
        },
        { onlyIfPreviousChanged: true, id: auditId },
      ),
      noticeStatement(
        database,
        snap.targetId,
        "role_changed",
        { actorName, oldRole: snap.targetRole, newRole },
        now,
        applied,
      ),
      ...(snap.targetRole === "member" && promotes
        ? [
            database.statement(
              `UPDATE magic_link_issues SET revoked_at = ?1
                WHERE (user_id = ?2 OR email_normalised = (SELECT email_normalised FROM users WHERE id = ?2))
                  AND consumed_at IS NULL AND revoked_at IS NULL
                  AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?3)`,
              now,
              snap.targetId,
              auditId,
            ),
          ]
        : []),
    ]),
  );
  if ((result[0]?.changes ?? 0) !== 1) {
    const explained = await explainNoop(ctx, snap, removesOwner);
    if (explained.reason !== "member_changed" || minPasskeys === 0) return err(explained);
    // The role and status are as decided, so a passkey went away meanwhile.
    return err(
      apiError("forbidden", "This person needs more passkeys before they can have that role.", {
        reason: "promotion_passkeys",
      }),
    );
  }

  await emailSecurityNotices(ctx, [
    { userId: snap.targetId, kind: "role_changed", details: { actorName, oldRole: snap.targetRole, newRole }, at: now },
  ]);
  return ok({ id: snap.targetId, role: newRole, status, changed: true });
}

/**
 * `POST /admin/members/:id/sign-out`, authorized as `member.sign_out_all`: revokes every session of the
 * person (better-auth's rows, deleted by our conditional SQL) and closes their live sockets. Returns how
 * many sessions were revoked.
 */
export async function signOutMember(
  ctx: CoreContext,
  actor: { userId: string; role: WorkspaceRole },
  check: MemberCheck,
): Promise<Result<{ signedOut: number }, ApiError>> {
  const snap = snapshotOf(actor.userId, actor.role, check);
  const database = new Database(ctx.env.DB);
  const still = `EXISTS (SELECT 1 FROM users t WHERE t.id = ?1 AND t.role = ?2 AND t.status = ?3)
    AND EXISTS (SELECT 1 FROM users a WHERE a.id = ?4 AND a.status = 'active' AND a.role = ?5)`;
  const stillPlain = `EXISTS (SELECT 1 FROM users t WHERE t.id = ? AND t.role = ? AND t.status = ?)
    AND EXISTS (SELECT 1 FROM users a WHERE a.id = ? AND a.status = 'active' AND a.role = ?)`;
  const stillParams = [snap.targetId, snap.targetRole, snap.targetStatus, snap.actorId, snap.actorRole];
  const auditId = ulid();
  const rows = expectOk(
    await database.batch<{ id: string }>([
      // Audited first, in the same batch, whenever the guard holds (also with no session), with the
      // number of sessions about to be revoked counted in SQL. The metadata is that count alone, so it
      // needs none of the writer's sanitising.
      database.statement(
        `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, metadata, created_at)
         SELECT ?, ?, 'member.signed_out', 'user', ?,
                json_object('sessionsRevoked', (SELECT count(*) FROM sessions WHERE user_id = ?)), ?
          WHERE ${stillPlain}`,
        auditId,
        actor.userId,
        snap.targetId,
        snap.targetId,
        ctx.now(),
        ...stillParams,
      ),
      database.statement(
        `DELETE FROM sessions WHERE user_id = ?1 AND ${still} RETURNING id`,
        snap.targetId,
        snap.targetRole,
        snap.targetStatus,
        snap.actorId,
        snap.actorRole,
      ),
      database.statement("SELECT 1 AS ok FROM audit_log WHERE id = ?", auditId),
    ]),
  );
  const revoked = rows[1]?.length ?? 0;
  if ((rows[2]?.length ?? 0) === 0) return err(await explainNoop(ctx, snap, false));
  // Sockets are closed even when no row was deleted: an expired session's sockets may still be open.
  try {
    await closeAllUserConnections(ctx.env, ctx.log, snap.targetId, "session_revoked");
  } catch (error) {
    ctx.log.error("closing a signed-out member's sockets failed", { userId: snap.targetId, error });
  }
  return ok({ signedOut: revoked });
}

/**
 * `DELETE /admin/members/:id`, authorized as `member.delete`. Marks the account deleted and signs it out
 * in one batch (conditional like a disable, and never the last active owner), closes its sockets, then
 * runs the erase. Irreversible.
 */
export async function deleteMember(
  ctx: CoreContext,
  actor: { userId: string; role: WorkspaceRole },
  check: MemberCheck,
): Promise<Result<MemberDeletedResult, ApiError>> {
  const snap = snapshotOf(actor.userId, actor.role, check);
  const now = ctx.now();
  const auditId = ulid();
  const database = new Database(ctx.env.DB);
  const guard = stillAsDecided(snap);
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE users SET status = 'deleted', deleted_at = ?, updated_at = ?
          WHERE id = ? AND ${guard.sql} AND (role != 'owner' OR ${ANOTHER_OWNER})`,
        now,
        now,
        snap.targetId,
        ...guard.params,
      ),
      await auditStatement(
        ctx,
        {
          action: "member.deleted",
          actor: actor.userId,
          target: { type: "user", id: snap.targetId },
          metadata: { role: snap.targetRole, previousStatus: snap.targetStatus },
        },
        { onlyIfPreviousChanged: true, id: auditId },
      ),
      ...revokeEverythingStatements(database, snap.targetId, now),
      ...(await revokeSentInvitationsStatements(
        ctx,
        database,
        actor.userId,
        snap.targetId,
        now,
        "inviter_deleted",
        auditId,
      )),
    ]),
  );
  if ((result[0]?.changes ?? 0) !== 1) return err(await explainNoop(ctx, snap, snap.targetRole === "owner"));
  await closeSockets(ctx, snap.targetId);
  try {
    await eraseDeletedMember(ctx, snap.targetId);
  } catch (error) {
    // The account is deleted and signed out; the hourly repair job finishes the erase.
    ctx.log.error("erasing a deleted member failed; the repair job retries", { userId: snap.targetId, error });
  }
  return ok({ id: snap.targetId, deleted: true });
}

/** The display name a deleted member's row and content show (Platform §3). */
export const FORMER_MEMBER = "Former member";

/**
 * The erase list (Platform §3.1) for one deleted account, idempotent: runs for a `deleted` user only,
 * and running it again changes nothing more. The D1 part is one batch; the avatar objects in R2 go
 * after it, and `avatar_key` is cleared only once they're gone, so the repair job can tell an
 * unfinished erase (`email` or `avatar_key` still set) and retry it.
 *
 * Tables of later milestones (chat, calendar, documents, notifications, assistant, projects) join this
 * list with their milestones. `mfa_factors` doesn't exist yet (TOTP is Phase 2).
 */
export async function eraseDeletedMember(ctx: CoreContext, userId: string): Promise<boolean> {
  const database = new Database(ctx.env.DB);
  const row = expectOk(
    await database.first<{ email: string | null; email_normalised: string | null; avatar_key: string | null }>(
      "SELECT email, email_normalised, avatar_key FROM users WHERE id = ? AND status = 'deleted'",
      userId,
    ),
  );
  if (!row) return false;
  const now = ctx.now();
  // Recorded before anything else, so a row whose erase keeps failing goes to the back of the retry queue.
  expectOk(
    await database.run("UPDATE users SET erase_attempted_at = ? WHERE id = ? AND status = 'deleted'", now, userId),
  );
  const email = row.email;
  const normalised = row.email_normalised ?? "";
  const deleted = "EXISTS (SELECT 1 FROM users WHERE id = ?1 AND status = 'deleted')";
  const statements: D1PreparedStatement[] = [
    ...["passkeys", "auth_tokens", "sessions", "auth_accounts", "user_devices", "ws_tickets"].map((table) =>
      database.statement(`DELETE FROM ${table} WHERE user_id = ?1 AND ${deleted}`, userId),
    ),
    ...["user_preferences", "user_availability", "group_members", "handle_changes"].map((table) =>
      database.statement(`DELETE FROM ${table} WHERE user_id = ?1 AND ${deleted}`, userId),
    ),
    // Pending magic links for their address, and better-auth's verification rows for it.
    database.statement(
      `DELETE FROM magic_link_issues WHERE (user_id = ?1 OR (?2 != '' AND email_normalised = ?2)) AND ${deleted}`,
      userId,
      normalised,
    ),
    // The handle is released and held for 30 days (Identity §4.8; Platform §3).
    database.statement(
      `UPDATE handles SET released_at = ?2
        WHERE owner_type = 'user' AND owner_id = ?1 AND released_at IS NULL AND ${deleted}`,
      userId,
      now,
    ),
  ];
  if (email) {
    const pseudonym = await hashPersonal(ctx.env, "email", email);
    statements.push(
      database.statement(
        `DELETE FROM auth_verifications
          WHERE json_valid(value) AND lower(json_extract(value, '$.email')) = ?2 AND ${deleted}`,
        userId,
        normalised,
      ),
      // Invitations sent to them: the email is replaced by its pseudonym (Platform §3.1); a pending one is
      // revoked with it.
      database.statement(
        `UPDATE invitations SET email = ?2, email_normalised = ?2,
            revoked_at = CASE WHEN accepted_at IS NULL AND accepted_attempt_id IS NULL THEN coalesce(revoked_at, ?4) ELSE revoked_at END
          WHERE (accepted_by = ?1 OR email_normalised = ?3) AND ${deleted}`,
        userId,
        pseudonym,
        normalised,
        now,
      ),
    );
    // Audit metadata holds emails only as pseudonyms (core/audit.ts), never names or raw values; their
    // address's pseudonym becomes the user ID and "Former member" (Platform §3.1).
    if (!pseudonym.startsWith("[")) {
      statements.push(
        database.statement(
          `UPDATE audit_log SET metadata = replace(metadata, ?2, ?3) WHERE instr(metadata, ?2) > 0 AND ${deleted}`,
          userId,
          pseudonym,
          `user:${userId} (${FORMER_MEMBER})`,
        ),
      );
    }
  }
  statements.push(
    database.statement(
      `UPDATE users SET email = NULL, email_normalised = NULL, email_verified = 0, handle = NULL,
          display_name = ?2, phone = NULL, pronouns = NULL, job_title = NULL, team = NULL, location = NULL,
          status_emoji = NULL, status_text = NULL, status_expires_at = NULL, timezone = 'UTC',
          working_hours = NULL, region = NULL, pending_security_notice = NULL,
          admin_reset_at = NULL, admin_reset_by = NULL, admin_reset_acknowledged_by = NULL, updated_at = ?3
        WHERE id = ?1 AND status = 'deleted' AND email IS NOT NULL`,
      userId,
      FORMER_MEMBER,
      now,
    ),
    await auditStatement(
      ctx,
      { action: "member.erased", actor: null, target: { type: "user", id: userId } },
      { onlyIfPreviousChanged: true },
    ),
  );
  expectOk(await database.batchRun(statements));

  // The avatar objects (R2), then the key: a failure here leaves `avatar_key` set for the retry.
  if (row.avatar_key !== null) {
    await deleteAvatarObjects(ctx.env.FILES, userId);
    expectOk(await database.run("UPDATE users SET avatar_key = NULL WHERE id = ? AND status = 'deleted'", userId));
  }
  return true;
}

/**
 * The repair job's half (hourly): finishes erases that didn't complete, least recently attempted first
 * (`erase_attempted_at`), so one row that keeps failing can't starve the rest. At most 25 per run
 * (default); each failure is logged with the member's ID.
 */
export async function eraseUnfinishedDeletions(ctx: CoreContext): Promise<number> {
  const rows = expectOk(
    await new Database(ctx.env.DB).all<{ id: string }>(
      `SELECT id FROM users WHERE status = 'deleted' AND (email IS NOT NULL OR avatar_key IS NOT NULL)
        ORDER BY coalesce(erase_attempted_at, 0), deleted_at LIMIT 25`,
    ),
  );
  let erased = 0;
  for (const row of rows) {
    try {
      if (await eraseDeletedMember(ctx, row.id)) erased++;
    } catch (error) {
      ctx.log.error("erase of a deleted member failed; retried next hour", { userId: row.id, error });
    }
  }
  return erased;
}
