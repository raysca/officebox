import { apiError, err, ok, type ApiError, type DeviceSession, type Result } from "@officebox/shared";
import { audit } from "../../core/audit";
import type { AuthContext, CoreContext } from "../../core/context";
import { authorize, type PermissionContext } from "../../core/permissions";
import type { Auth } from "./auth";

/**
 * "My devices" (Identity §4.5): list, sign out one, sign out all others, sign out everywhere, on
 * better-auth's list and revoke (`auth.api`, never exposed directly). Our routes return session IDs and
 * device fields, **never tokens**. Each revocation deletes rows through better-auth, which fires
 * `session.delete.after` per row and so closes that session's sockets (`revocation.ts`).
 */

interface BetterAuthSession {
  id: string;
  token: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  deviceLabel?: unknown;
  approxLocation?: unknown;
}

function ms(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

async function sessionsOf(auth: Auth, headers: Headers): Promise<BetterAuthSession[]> {
  return (await auth.api.listSessions({ headers })) as unknown as BetterAuthSession[];
}

export async function listDevices(
  permission: PermissionContext,
  auth: Auth,
  headers: Headers,
  me: AuthContext,
): Promise<Result<DeviceSession[], ApiError>> {
  const allowed = await authorize(permission, { action: "devices.view", ownerId: me.userId });
  if (!allowed.ok) return allowed;
  const sessions = await sessionsOf(auth, headers);
  return ok(
    sessions
      .map((s) => ({
        id: s.id,
        deviceLabel: typeof s.deviceLabel === "string" ? s.deviceLabel : null,
        approxLocation: typeof s.approxLocation === "string" ? s.approxLocation : null,
        createdAt: ms(s.createdAt),
        lastSeenAt: ms(s.updatedAt),
        current: s.id === me.sessionId,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt),
  );
}

export async function signOutDevice(
  ctx: CoreContext,
  permission: PermissionContext,
  auth: Auth,
  headers: Headers,
  me: AuthContext,
  sessionId: string,
): Promise<Result<null, ApiError>> {
  // The list is the member's own, so another member's session ID simply isn't found (404).
  const target = (await sessionsOf(auth, headers)).find((s) => s.id === sessionId);
  if (!target) return err(apiError("not_found", "No such session."));
  const allowed = await authorize(permission, { action: "devices.sign_out", ownerId: me.userId }, { hideAs404: true });
  if (!allowed.ok) return allowed;
  await auth.api.revokeSession({ headers, body: { token: target.token } });
  await audit(ctx, { action: "session.revoked", actor: me.userId, target: { type: "session", id: sessionId } });
  return ok(null);
}

export async function signOutOthers(
  ctx: CoreContext,
  permission: PermissionContext,
  auth: Auth,
  headers: Headers,
  me: AuthContext,
): Promise<Result<{ signedOut: number }, ApiError>> {
  const allowed = await authorize(permission, { action: "devices.sign_out", ownerId: me.userId });
  if (!allowed.ok) return allowed;
  const before = (await sessionsOf(auth, headers)).filter((s) => s.id !== me.sessionId).length;
  await auth.api.revokeOtherSessions({ headers });
  await audit(ctx, { action: "session.revoked_others", actor: me.userId, target: { type: "user", id: me.userId } });
  return ok({ signedOut: before });
}

export async function signOutEverywhere(
  ctx: CoreContext,
  permission: PermissionContext,
  auth: Auth,
  headers: Headers,
  me: AuthContext,
): Promise<Result<{ headers: Headers }, ApiError>> {
  const allowed = await authorize(permission, { action: "devices.sign_out", ownerId: me.userId });
  if (!allowed.ok) return allowed;
  const result = await auth.api.revokeSessions({ headers, returnHeaders: true });
  await audit(ctx, { action: "session.revoked_all", actor: me.userId, target: { type: "user", id: me.userId } });
  return ok({ headers: result.headers });
}
