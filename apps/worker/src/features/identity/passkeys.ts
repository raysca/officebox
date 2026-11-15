import {
  apiError,
  err,
  ok,
  passkeyCreatedViaSchema,
  type ApiError,
  type PasskeySummary,
  type Result,
} from "@officebox/shared";
import { auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { authorize, type PermissionContext } from "../../core/permissions";

/**
 * Signed-in passkey management (Identity §4.4, §6): list, rename and remove **own** passkeys. Adding
 * one goes through better-auth's registration routes behind step-up (`routes.ts`).
 *
 * Rename and remove use our own SQL rather than better-auth's (unexposed) update and delete endpoints
 * **(default)**: the permission engine decides ownership and the last-passkey rule, and the remove is
 * one conditional DELETE that re-checks the count, so two concurrent removals can never take away the
 * last passkey. better-auth's delete has no such condition.
 */

const NOT_FOUND: ApiError = apiError("not_found", "No such passkey.");

interface PasskeyRow {
  id: string;
  user_id: string;
  name: string | null;
  created_via: string;
  created_at: number | null;
  last_used_at: number | null;
  device_type: string;
  backed_up: number;
}

function summary(row: PasskeyRow): PasskeySummary {
  const via = passkeyCreatedViaSchema.safeParse(row.created_via);
  return {
    id: row.id,
    name: row.name,
    createdVia: via.success ? via.data : "signed_in",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
  };
}

const COLUMNS = "id, user_id, name, created_via, created_at, last_used_at, device_type, backed_up";

export async function listPasskeys(ctx: CoreContext, userId: string): Promise<PasskeySummary[]> {
  const rows = expectOk(
    await new Database(ctx.env.DB).all<PasskeyRow>(
      `SELECT ${COLUMNS} FROM passkeys WHERE user_id = ? ORDER BY created_at, id`,
      userId,
    ),
  );
  return rows.map(summary);
}

async function find(ctx: CoreContext, id: string): Promise<PasskeyRow | null> {
  return expectOk(await new Database(ctx.env.DB).first<PasskeyRow>(`SELECT ${COLUMNS} FROM passkeys WHERE id = ?`, id));
}

export async function renamePasskey(
  ctx: CoreContext,
  permission: PermissionContext,
  id: string,
  name: string,
): Promise<Result<PasskeySummary, ApiError>> {
  const row = await find(ctx, id);
  if (!row) return err(NOT_FOUND);
  // Someone else's passkey answers 404 too, so passkey IDs can't be probed.
  const hideAs404 = row.user_id !== permission.actor.userId;
  const allowed = await authorize(permission, { action: "passkey.rename", ownerId: row.user_id }, { hideAs404 });
  if (!allowed.ok) return allowed;
  const db = new Database(ctx.env.DB);
  expectOk(await db.run("UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?", name, id, row.user_id));
  return ok(summary({ ...row, name }));
}

export async function removePasskey(
  ctx: CoreContext,
  permission: PermissionContext,
  id: string,
): Promise<Result<null, ApiError>> {
  const row = await find(ctx, id);
  if (!row) return err(NOT_FOUND);
  // Someone else's passkey answers 404; on one's own, the specific reason (last passkey, step-up).
  const hideAs404 = row.user_id !== permission.actor.userId;
  const allowed = await authorize(permission, { action: "passkey.remove", ownerId: row.user_id }, { hideAs404 });
  if (!allowed.ok) return allowed;
  const db = new Database(ctx.env.DB);
  // The engine allowed it for the count it read; the DELETE re-checks, so a concurrent removal can't
  // leave the person with none. (Magic links don't exist before M1b, so nobody may remove their last.)
  const result = expectOk(
    await db.batchRun([
      db.statement(
        `DELETE FROM passkeys WHERE id = ? AND user_id = ?
           AND (SELECT count(*) FROM passkeys WHERE user_id = ?) > 1`,
        id,
        row.user_id,
        row.user_id,
      ),
      await auditStatement(
        ctx,
        { action: "passkey.removed", actor: permission.actor.userId, target: { type: "passkey", id } },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  if ((result[0]?.changes ?? 0) === 0) {
    return err(apiError("forbidden", "You can't remove your last passkey.", { reason: "last_passkey" }));
  }
  return ok(null);
}
