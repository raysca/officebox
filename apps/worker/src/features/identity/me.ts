import { apiError, err, ok, workspaceRoleSchema, type ApiError, type Me, type Result } from "@officebox/shared";
import type { AuthContext, CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import type { ClaimedInstallation } from "./installation";
import { parseNotices } from "./notices";

/** `GET /me` (Identity §6): the signed-in member, the workspace, passkey count and the banner list. */
export async function getMe(
  ctx: CoreContext,
  auth: AuthContext,
  installation: ClaimedInstallation,
): Promise<Result<Me, ApiError>> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{
      id: string;
      email: string | null;
      display_name: string;
      handle: string | null;
      role: string;
      pending_security_notice: string | null;
      passkeys: number;
    }>(
      `SELECT id, email, display_name, handle, role, pending_security_notice,
              (SELECT count(*) FROM passkeys WHERE user_id = users.id) AS passkeys
         FROM users WHERE id = ? AND status = 'active'`,
      auth.userId,
    ),
  );
  const role = workspaceRoleSchema.safeParse(row?.role);
  if (!row || row.email === null || !role.success) return err(apiError("unauthenticated", "Sign in to continue."));
  return ok({
    user: { id: row.id, email: row.email, displayName: row.display_name, handle: row.handle, role: role.data },
    workspace: { name: installation.workspaceName, canonicalOrigin: installation.canonicalOrigin },
    passkeyCount: row.passkeys,
    securityNotices: parseNotices(row.pending_security_notice),
    session: { freshAuthAt: auth.freshAuthAt, freshAuthMethod: auth.freshAuthMethod },
  });
}
