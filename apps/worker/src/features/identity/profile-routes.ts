import {
  apiError,
  directoryQuerySchema,
  err,
  normaliseHandle,
  ok,
  setStatusBodySchema,
  ulidSchema,
  updateProfileBodySchema,
  validationError,
} from "@officebox/shared";
import { Hono } from "hono";
import { defineFeature } from "../../core/app";
import { authOf, coreContext, type AppContext, type AppEnv } from "../../core/context";
import { readJson, respond } from "../../core/errors";
import { authorize } from "../../core/permissions";
import { avatarResponse, removeAvatar, uploadAvatar } from "./avatar";
import { permissionContext } from "./facts";
import { handleAvailability } from "./handles";
import { requireAuth } from "./middleware";
import { getMember, getMyProfile, listDirectory, setStatus, updateProfile } from "./profile";

/**
 * Profile, status, avatar, handle and directory routes (M1d; Identity §6). Paths are relative to `/api`.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /me/profile` · `PATCH /me/profile` | Member (own; `profile.edit`, plus `handle.change` with a handle) |
 * | `PUT /me/avatar` · `DELETE /me/avatar` | Member (own; `avatar.edit`) |
 * | `PUT /me/status` · `DELETE /me/status` | Member (own; `status.edit`) |
 * | `GET /handles/:handle/available` | Member (`directory.view`) |
 * | `GET /members` · `GET /members/:id` · `GET /members/:id/avatar` | Member (`directory.view`, `profile.view`) |
 *
 * Every route asks the permission engine; nobody, an admin or owner included, edits someone else's
 * profile (Permissions §4.6). Live presence learns about status changes through the member's UserHub.
 */

const SMALL_BODY = 16 * 1024;
const NO_MEMBER = apiError("not_found", "No such member.");

/**
 * Tells the member's UserHub that their status changed, so live presence follows and the hub schedules
 * the expiry. Tried up to 3 times (D1 is already written, so the request still succeeds). If every try
 * fails, the hub catches up by itself: it re-reads the status from D1 (and re-arms the expiry timer)
 * on every 5-minute heartbeat and whenever the member comes online, so presence is stale for at most
 * one heartbeat, and every REST read hides an expired status regardless.
 */
async function syncLiveStatus(c: AppContext, userId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await c.env.USER_HUB.getByName(userId).refreshStatus(userId);
      if (result.ok) return;
      c.var.log.warn("profile: live status not refreshed", { code: result.error.code, attempt });
    } catch (error) {
      c.var.log.warn("profile: live status not refreshed", { error, attempt });
    }
  }
}

/** A time zone change moves DND schedules and working-hours boundaries: recompute availability. */
async function syncAvailability(c: AppContext, userId: string): Promise<void> {
  try {
    const result = await c.env.USER_HUB.getByName(userId).refreshAvailability(userId);
    if (!result.ok) c.var.log.warn("profile: availability not refreshed", { code: result.error.code });
  } catch (error) {
    c.var.log.warn("profile: availability not refreshed", { error });
  }
}

/** Mounted on the `me` feature, after `requireAuth`. */
export const meProfileRoutes = new Hono<AppEnv>()
  .get("/profile", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "profile.edit", ownerId: me.userId });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, await getMyProfile(coreContext(c), me.userId));
  })
  .patch("/profile", async (c) => {
    const me = authOf(c);
    const permission = permissionContext(c, me);
    const allowed = await authorize(permission, { action: "profile.edit", ownerId: me.userId });
    if (!allowed.ok) return respond(c, allowed);
    const body = await readJson(c, updateProfileBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    if (body.value.handle !== undefined) {
      const handle = await authorize(permission, { action: "handle.change", ownerId: me.userId });
      if (!handle.ok) return respond(c, handle);
    }
    const result = await updateProfile(coreContext(c), me.userId, body.value);
    if (!result.ok) return respond(c, result);
    if (result.value.timezoneChanged) {
      await syncAvailability(c, me.userId);
      // The status expiry is an instant, unaffected; nothing else to refresh.
    }
    return respond(c, ok(result.value.profile));
  })
  .put("/avatar", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "avatar.edit", ownerId: me.userId });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, await uploadAvatar(coreContext(c), me.userId, c.req.raw));
  })
  .delete("/avatar", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "avatar.edit", ownerId: me.userId });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, await removeAvatar(coreContext(c), me.userId));
  })
  .put("/status", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "status.edit", ownerId: me.userId });
    if (!allowed.ok) return respond(c, allowed);
    const body = await readJson(c, setStatusBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const result = await setStatus(coreContext(c), me.userId, body.value);
    if (!result.ok) return respond(c, result);
    await syncLiveStatus(c, me.userId);
    return respond(c, ok({ status: result.value }));
  })
  .delete("/status", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "status.edit", ownerId: me.userId });
    if (!allowed.ok) return respond(c, allowed);
    const result = await setStatus(coreContext(c), me.userId, { emoji: null, text: null, expiresAt: null });
    if (!result.ok) return respond(c, result);
    await syncLiveStatus(c, me.userId);
    return respond(c, ok({ status: null }));
  });

/** `/api/members`: the directory (mounted by the realtime `members` feature, beside availability). */
export const directoryRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "directory.view" });
    if (!allowed.ok) return respond(c, allowed);
    const parsed = directoryQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return respond(c, err(validationError(parsed.error)));
    return respond(c, await listDirectory(coreContext(c), parsed.data));
  })
  .get("/:id", async (c) => {
    const me = authOf(c);
    const id = c.req.param("id");
    if (!ulidSchema.safeParse(id).success) return respond(c, err(NO_MEMBER));
    // Deleted and reserved people answer 404, like unknown IDs (Identity §4.10).
    const allowed = await authorize(
      permissionContext(c, me),
      { action: "profile.view", targetId: id },
      { hideAs404: true },
    );
    if (!allowed.ok) return respond(c, allowed);
    const member = await getMember(coreContext(c), id);
    return respond(c, member ? ok(member) : err(NO_MEMBER));
  })
  .get("/:id/avatar", async (c) => {
    const me = authOf(c);
    const id = c.req.param("id");
    if (!ulidSchema.safeParse(id).success) return respond(c, err(NO_MEMBER));
    const allowed = await authorize(
      permissionContext(c, me),
      { action: "profile.view", targetId: id },
      { hideAs404: true },
    );
    if (!allowed.ok) return respond(c, allowed);
    const response = await avatarResponse(coreContext(c), id);
    return response ?? respond(c, err(apiError("not_found", "No avatar.")));
  });

/** `/api/handles` (Identity §6: handle check). */
const handleRoutes = new Hono<AppEnv>().use(requireAuth).get("/:handle/available", async (c) => {
  const me = authOf(c);
  const allowed = await authorize(permissionContext(c, me), { action: "directory.view" });
  if (!allowed.ok) return respond(c, allowed);
  const handle = normaliseHandle(c.req.param("handle")).slice(0, 64);
  return respond(c, ok(await handleAvailability(c.env.DB, handle, me.userId, c.var.now())));
});

export const handlesFeature = defineFeature("handles", handleRoutes);
