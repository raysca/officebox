import {
  apiError,
  err,
  ok,
  workspaceRoleSchema,
  type AdminMember,
  type ApiError,
  type Result,
  type WorkspaceRole,
} from "@officebox/shared";
import { z } from "zod";
import { auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";

/**
 * The admin area's member list, as M1c needs it (Identity §4.6, §4.11; Admin §5): who is in the
 * workspace, their role, status and passkeys, a pending email change, and for **owners** the no-email
 * recovery-link flag ("Recovery link issued by *Admin* on *date*") until an owner acknowledges it.
 * Filters, profiles, bulk tools and the CSV arrive with M1e and Admin §5.
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

/** Active and disabled members (never reserved rows or deleted people), owners first, then by name. */
export async function listAdminMembers(ctx: CoreContext, actorRole: WorkspaceRole): Promise<AdminMember[]> {
  const now = ctx.now();
  const rows = expectOk(
    await new Database(ctx.env.DB).all<MemberRow>(
      `SELECT u.id, u.email, u.display_name, u.handle, u.role, u.status,
              (SELECT count(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
              u.admin_reset_at, u.admin_reset_acknowledged_by,
              (SELECT display_name FROM users r WHERE r.id = u.admin_reset_by) AS reset_by_name,
              (SELECT payload FROM auth_tokens t
                WHERE t.user_id = u.id AND t.kind = 'email_change' AND t.used_at IS NULL AND t.revoked_at IS NULL
                  AND t.expires_at > ? ORDER BY t.created_at DESC LIMIT 1) AS pending_payload
         FROM users u
        WHERE u.status IN ('active', 'disabled') AND u.email IS NOT NULL
        ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name COLLATE NOCASE, u.id
        LIMIT 1000`,
      now,
    ),
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
    });
  }
  return out;
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
