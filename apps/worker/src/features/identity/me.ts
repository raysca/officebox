import { apiError, err, ok, workspaceRoleSchema, type ApiError, type Me, type Result } from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { workspaceName } from "./setup";

/** `GET /me` (Identity §6): the signed-in member and the workspace's name. */
export async function getMe(ctx: CoreContext, userId: string): Promise<Result<Me, ApiError>> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{
      id: string;
      email: string | null;
      display_name: string;
      handle: string | null;
      role: string;
    }>("SELECT id, email, display_name, handle, role FROM users WHERE id = ? AND status = 'active'", userId),
  );
  const role = workspaceRoleSchema.safeParse(row?.role);
  if (!row || row.email === null || !role.success) return err(apiError("unauthenticated", "Sign in to continue."));
  return ok({
    user: { id: row.id, email: row.email, displayName: row.display_name, handle: row.handle, role: role.data },
    workspace: { name: await workspaceName(ctx) },
  });
}
