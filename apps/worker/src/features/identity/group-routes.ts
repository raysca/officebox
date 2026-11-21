import {
  apiError,
  createGroupBodySchema,
  err,
  ok,
  personRefSchema,
  putGroupMemberBodySchema,
  ulidSchema,
  updateGroupBodySchema,
  type ApiError,
} from "@officebox/shared";
import { Hono } from "hono";
import { defineFeature } from "../../core/app";
import { authOf, coreContext, type AppEnv } from "../../core/context";
import { readJson, respond } from "../../core/errors";
import { authorize, authorizeCheck } from "../../core/permissions";
import { permissionContext } from "./facts";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  membershipOf,
  removeGroupMember,
  setGroupMemberRole,
  updateGroup,
} from "./groups";
import { requireAuth } from "./middleware";

/**
 * Groups (Identity §4.9, §6; Permissions §4.6, §6; M1e), under `/api/groups`. Every route asks the
 * permission engine:
 *
 * | Route | Who |
 * |---|---|
 * | `GET /groups` · `GET /groups/:id` | Every member (`directory.view`: groups are part of the directory) |
 * | `POST /groups` | Owner, admin (`groups.manage`); each named manager is an add (`group.add_member`) |
 * | `PATCH /groups/:id` · `DELETE /groups/:id` | Owner, admin (`groups.manage`) |
 * | `PUT /groups/:id/members/:userId` `{ role }` | Add: `group.add_member` (admins, or the group's managers; an admin adding themselves needs an owner). Appointing or removing a manager: `groups.manage` too |
 * | `DELETE /groups/:id/members/:userId` | `group.remove_member` (admins, or the group's managers for members and themselves) |
 */

const SMALL_BODY = 16 * 1024;
const NO_GROUP: ApiError = apiError("not_found", "No such group.");
const NO_MEMBER: ApiError = apiError("not_found", "No such member.");

const isUlid = (value: string | undefined): value is string => !!value && ulidSchema.safeParse(value).success;

const groupRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "directory.view" });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, ok({ groups: await listGroups(coreContext(c), me.userId) }));
  })
  .get("/:id", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "directory.view" });
    if (!allowed.ok) return respond(c, allowed);
    const id = c.req.param("id");
    if (!isUlid(id)) return respond(c, err(NO_GROUP));
    const group = await getGroup(coreContext(c), me.userId, id);
    return respond(c, group ? ok(group) : err(NO_GROUP));
  })
  .post("/", async (c) => {
    const me = authOf(c);
    const permission = permissionContext(c, me);
    const allowed = await authorize(permission, { action: "groups.manage" });
    if (!allowed.ok) return respond(c, allowed);
    const body = await readJson(c, createGroupBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    // Each named manager is added to the new group: the same rule as any add, so an admin naming
    // themselves needs an owner (Permissions §6). The group doesn't exist yet, so it has no managers.
    for (const managerId of new Set(body.value.managerIds ?? [])) {
      const loaded = await permission.facts.person(managerId);
      const target = loaded ? personRefSchema.safeParse(loaded) : null;
      if (!target?.success) return respond(c, err(NO_MEMBER));
      const add = authorizeCheck(permission, {
        action: "group.add_member",
        group: { managerIds: [] },
        target: target.data,
      });
      if (!add.ok) return respond(c, add);
    }
    return respond(c, await createGroup(coreContext(c), me.userId, body.value), 201);
  })
  .patch("/:id", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "groups.manage" });
    if (!allowed.ok) return respond(c, allowed);
    const id = c.req.param("id");
    if (!isUlid(id)) return respond(c, err(NO_GROUP));
    const body = await readJson(c, updateGroupBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    return respond(c, await updateGroup(coreContext(c), me.userId, id, body.value));
  })
  .delete("/:id", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "groups.manage" });
    if (!allowed.ok) return respond(c, allowed);
    const id = c.req.param("id");
    if (!isUlid(id)) return respond(c, err(NO_GROUP));
    const deleted = await deleteGroup(coreContext(c), me.userId, id);
    return respond(c, deleted.ok ? ok({ deleted: true }) : deleted);
  })
  .put("/:id/members/:userId", async (c) => {
    const me = authOf(c);
    const permission = permissionContext(c, me);
    const groupId = c.req.param("id");
    const userId = c.req.param("userId");
    const body = await readJson(c, putGroupMemberBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const role = body.value.role;
    // Appointing a manager is an admin's (Identity §4.9): ask first, so nobody else learns more.
    if (role === "manager") {
      const manage = await authorize(permission, { action: "groups.manage" });
      if (!manage.ok) return respond(c, manage);
    }
    if (!isUlid(groupId)) return respond(c, err(NO_GROUP));
    if (!isUlid(userId)) return respond(c, err(NO_MEMBER));
    const ctx = coreContext(c);
    const existing = await membershipOf(c.env.DB, groupId, userId);
    if (!existing) {
      const add = await authorize(permission, { action: "group.add_member", groupId, memberId: userId });
      if (!add.ok) return respond(c, add);
      return respond(c, await addGroupMember(ctx, me.userId, groupId, userId, role));
    }
    if (existing.role === role) {
      // Already so: the caller must still be someone who manages this group's membership.
      const may = await authorize(permission, { action: "group.remove_member", groupId, memberId: userId });
      if (!may.ok) return respond(c, may);
      return respond(c, ok({ groupId, userId, role, changed: false }));
    }
    // A manager made a plain member again: appointing and removing managers is an admin's.
    const manage = await authorize(permission, { action: "groups.manage" });
    if (!manage.ok) return respond(c, manage);
    return respond(c, await setGroupMemberRole(ctx, me.userId, groupId, userId, existing.role, role));
  })
  .delete("/:id/members/:userId", async (c) => {
    const me = authOf(c);
    const groupId = c.req.param("id");
    const userId = c.req.param("userId");
    if (!isUlid(groupId)) return respond(c, err(NO_GROUP));
    if (!isUlid(userId)) return respond(c, err(NO_MEMBER));
    const allowed = await authorize(permissionContext(c, me), {
      action: "group.remove_member",
      groupId,
      memberId: userId,
    });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, await removeGroupMember(coreContext(c), me.userId, groupId, userId));
  });

export const groupsFeature = defineFeature("groups", groupRoutes);
