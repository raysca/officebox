import {
  apiError,
  err,
  ok,
  workspaceRoleSchema,
  type AdminMember,
  type AdminMembersQuery,
  type ApiError,
  type Result,
  type WorkspaceRole,
} from "@officebox/shared";
import { z } from "zod";
import { auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk, type SqlValue } from "../../core/db";
import { groupsOfUsers, liveGroupNames, parseGroupIds } from "./groups";

/**
 * The admin area's member list (Identity §4.6, §4.11; Admin §5): who is in the workspace, their role,
 * status, groups, passkeys, last active and joined dates, a pending email change, the pending-notice
 * flag, and for **owners** the no-email recovery-link flag ("Recovery link issued by *Admin* on *date*")
 * until an owner acknowledges it. Search by name, handle or email; filter by role, status (`invited`
 * lists pending invitations), group and last active (M1e). Bulk tools and the member CSV are Admin §5.1–
 * §5.4 (M7).
 */

interface MemberRow {
  id: string;
  email: string | null;
  display_name: string;
  handle: string | null;
  role: string;
  status: string;
  passkeys: number;
  admin_reset_at: number | null;
  admin_reset_acknowledged_by: string | null;
  reset_by_name: string | null;
  pending_payload: string | null;
  last_active: number | null;
  created_at: number;
  notices: number;
}

const pendingSchema = z.object({ newEmail: z.string() });

function pendingEmail(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.newEmail : null;
  } catch {
    return null;
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** A LIKE pattern matching `text` anywhere, with LIKE's wildcards escaped. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Active and disabled members (never reserved rows or deleted people), owners first, then by name; or
 * with `status: "invited"`, pending invitations as rows (no account yet, so no actions but those on the
 * Invitations page).
 */
export async function listAdminMembers(
  ctx: CoreContext,
  actorRole: WorkspaceRole,
  query: AdminMembersQuery = {},
): Promise<AdminMember[]> {
  if (query.status === "invited") return listInvitedRows(ctx, query);
  const now = ctx.now();
  const where = ["u.email IS NOT NULL"];
  const params: SqlValue[] = [now];
  if (query.status) {
    where.push("u.status = ?");
    params.push(query.status);
  } else {
    where.push("u.status IN ('active', 'disabled')");
  }
  if (query.role) {
    where.push("u.role = ?");
    params.push(query.role);
  }
  const q = query.q?.trim();
  if (q) {
    const pattern = containsPattern(q.replace(/^@/, "").toLowerCase());
    where.push(
      "(lower(u.display_name) LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\' OR u.email_normalised LIKE ? ESCAPE '\\')",
    );
    params.push(pattern, pattern, pattern);
  }
  if (query.group) {
    where.push(
      "EXISTS (SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = u.id AND gm.group_id = ? AND g.deleted_at IS NULL)",
    );
    params.push(query.group);
  }
  const lastActive = "(SELECT max(s.updated_at) FROM sessions s WHERE s.user_id = u.id)";
  switch (query.lastActive) {
    case "within_7d":
      where.push(`${lastActive} >= ?`);
      params.push(now - 7 * DAY);
      break;
    case "within_30d":
      where.push(`${lastActive} >= ?`);
      params.push(now - 30 * DAY);
      break;
    case "over_30d":
      where.push(`${lastActive} < ?`);
      params.push(now - 30 * DAY);
      break;
    case "never":
      where.push(`${lastActive} IS NULL`);
      break;
    case undefined:
      break;
  }
  const rows = expectOk(
    await new Database(ctx.env.DB).all<MemberRow>(
      `SELECT u.id, u.email, u.display_name, u.handle, u.role, u.status, u.created_at,
              (SELECT count(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
              u.admin_reset_at, u.admin_reset_acknowledged_by,
              (SELECT display_name FROM users r WHERE r.id = u.admin_reset_by) AS reset_by_name,
              (SELECT payload FROM auth_tokens t
                WHERE t.user_id = u.id AND t.kind = 'email_change' AND t.used_at IS NULL AND t.revoked_at IS NULL
                  AND t.expires_at > ?1 ORDER BY t.created_at DESC LIMIT 1) AS pending_payload,
              ${lastActive} AS last_active,
              json_array_length(coalesce(u.pending_security_notice, '[]')) AS notices
         FROM users u
        WHERE ${where.join(" AND ")}
        ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name COLLATE NOCASE, u.id
        LIMIT 1000`,
      ...params,
    ),
  );
  const groups = await groupsOfUsers(
    ctx.env.DB,
    rows.map((r) => r.id),
  );
  const out: AdminMember[] = [];
  for (const row of rows) {
    const role = workspaceRoleSchema.safeParse(row.role);
    if (!role.success || !row.email || (row.status !== "active" && row.status !== "disabled")) continue;
    const flagged = actorRole === "owner" && row.admin_reset_at !== null && row.admin_reset_acknowledged_by === null;
    out.push({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      handle: row.handle,
      role: role.data,
      status: row.status,
      passkeyCount: row.passkeys,
      recoveryFlag:
        flagged && row.admin_reset_at !== null ? { at: row.admin_reset_at, byName: row.reset_by_name } : null,
      pendingEmail: pendingEmail(row.pending_payload),
      groups: groups.get(row.id) ?? [],
      lastActiveAt: row.last_active,
      joinedAt: row.created_at,
      pendingSecurityNotice: row.notices > 0,
    });
  }
  return out;
}

interface InvitedRow {
  id: string;
  email: string;
  role: string;
  group_ids: string | null;
  created_at: number;
}

/** Pending invitations (not accepted, revoked or expired) as member-list rows. */
async function listInvitedRows(ctx: CoreContext, query: AdminMembersQuery): Promise<AdminMember[]> {
  const where = ["accepted_at IS NULL", "accepted_attempt_id IS NULL", "revoked_at IS NULL", "expires_at > ?"];
  const params: SqlValue[] = [ctx.now()];
  if (query.role) {
    where.push("role = ?");
    params.push(query.role);
  }
  const q = query.q?.trim();
  if (q) {
    where.push("email_normalised LIKE ? ESCAPE '\\'");
    params.push(containsPattern(q.toLowerCase()));
  }
  if (query.group) {
    where.push("EXISTS (SELECT 1 FROM json_each(coalesce(group_ids, '[]')) WHERE value = ?)");
    params.push(query.group);
  }
  // Nobody invited has been active; any "last active" filter but "never" excludes them.
  if (query.lastActive && query.lastActive !== "never") return [];
  const database = new Database(ctx.env.DB);
  const rows = expectOk(
    await database.all<InvitedRow>(
      `SELECT id, email, role, group_ids, created_at FROM invitations WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC LIMIT 1000`,
      ...params,
    ),
  );
  const names = await liveGroupNames(ctx.env.DB);
  return rows.flatMap((row): AdminMember[] => {
    const role = workspaceRoleSchema.safeParse(row.role);
    if (!role.success) return [];
    return [
      {
        id: row.id,
        email: row.email,
        displayName: row.email,
        handle: null,
        role: role.data,
        status: "invited",
        passkeyCount: 0,
        recoveryFlag: null,
        pendingEmail: null,
        groups: parseGroupIds(row.group_ids).flatMap((id) => {
          const group = names.get(id);
          return group ? [{ id, name: group.name, handle: group.handle }] : [];
        }),
        lastActiveAt: null,
        joinedAt: null,
        pendingSecurityNotice: false,
      },
    ];
  });
}

/**
 * `POST /admin/members/:id/acknowledge-reset` (owners; the engine's `member.acknowledge_reset`): clears
 * the owners' "recovery link issued" flag. Audited.
 */
export async function acknowledgeReset(
  ctx: CoreContext,
  actorId: string,
  targetId: string,
): Promise<Result<null, ApiError>> {
  const database = new Database(ctx.env.DB);
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE users SET admin_reset_acknowledged_by = ?
          WHERE id = ? AND admin_reset_at IS NOT NULL AND admin_reset_acknowledged_by IS NULL`,
        actorId,
        targetId,
      ),
      await auditStatement(
        ctx,
        { action: "member.reset_acknowledged", actor: actorId, target: { type: "user", id: targetId } },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  if ((result[0]?.changes ?? 0) === 1) return ok(null);
  return err(apiError("not_found", "There's no recovery-link flag to acknowledge.", { reason: "no_reset_flag" }));
}
