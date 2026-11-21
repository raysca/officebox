import {
  apiError,
  err,
  HANDLE_HOLD_MS,
  ok,
  type ApiError,
  type CreateGroupBody,
  type GroupDetail,
  type GroupMember,
  type GroupMemberRole,
  type GroupMembershipResult,
  type GroupSummary,
  type Result,
  type UpdateGroupBody,
} from "@officebox/shared";
import { z } from "zod";
import { auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { ulid } from "../../core/ids";
import { avatarUrl } from "./avatar";
import { handleAvailability, handleError } from "./handles";

/**
 * Groups (Identity §4.9, §5; Permissions §3.2, §4.6, §5.5, §6; Platform §4 "Group → delete"; M1e).
 *
 * Routes ask the permission engine first (`directory.view` to read, `groups.manage` to create, rename,
 * delete and appoint managers, `group.add_member` / `group.remove_member` for membership); these
 * functions only read and write, and every write re-checks in SQL what the decision relied on, so a
 * change that raced it (the actor demoted, the group deleted, the target disabled) writes nothing:
 *
 * - **Handles:** a group's @handle lives in the one `handles` namespace (`owner_type = 'group'`), with
 *   `groups.handle` as its copy, written in the same batch. Renaming or deleting a group releases the
 *   old handle, held for 30 days (Identity §4.8; Platform §4).
 * - **Deleting** is a soft delete: the members are removed and the handle released. The group drive and
 *   group calendar (Platform §4) arrive with M6a and M5a, and grants naming the group with M5a/M6a.
 * - **Audit:** every change, including each membership change, because a membership widens access to
 *   everything shared with the group (Identity §4.9; Permissions §5.5).
 */

interface GroupRow {
  id: string;
  name: string;
  handle: string | null;
  description: string | null;
  created_at: number;
  members: number;
  managers: number;
  you_manage: number;
  you_member: number;
}

const GROUP_SELECT = `SELECT g.id, g.name, g.handle, g.description, g.created_at,
    (SELECT count(*) FROM group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = g.id AND u.status IN ('active', 'disabled')) AS members,
    (SELECT count(*) FROM group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = g.id AND m.role = 'manager' AND u.status IN ('active', 'disabled')) AS managers,
    EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.user_id = ?1 AND m.role = 'manager') AS you_manage,
    EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.user_id = ?1) AS you_member
  FROM groups g`;

function toSummary(row: GroupRow): GroupSummary {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    description: row.description,
    memberCount: row.members,
    managerCount: row.managers,
    youManage: row.you_manage === 1,
    youAreMember: row.you_member === 1,
    createdAt: row.created_at,
  };
}

const NO_GROUP: ApiError = apiError("not_found", "No such group.");

function nameTaken(): ApiError {
  const message = "Another group already has this name.";
  return apiError("conflict", message, { reason: "group_name_taken", fields: { name: [message] } });
}

/** `GET /groups`: every group that isn't deleted, by name. */
export async function listGroups(ctx: CoreContext, viewerId: string): Promise<GroupSummary[]> {
  const rows = expectOk(
    await new Database(ctx.env.DB).all<GroupRow>(
      `${GROUP_SELECT} WHERE g.deleted_at IS NULL ORDER BY g.name COLLATE NOCASE, g.id LIMIT 1000`,
      viewerId,
    ),
  );
  return rows.map(toSummary);
}

interface MemberRow {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_key: string | null;
  status: string;
  role: string;
  added_at: number;
}

/** `GET /groups/:id`: the group and its members (managers first), or null when it doesn't exist. */
export async function getGroup(ctx: CoreContext, viewerId: string, groupId: string): Promise<GroupDetail | null> {
  const database = new Database(ctx.env.DB);
  const row = expectOk(
    await database.first<GroupRow>(`${GROUP_SELECT} WHERE g.id = ?2 AND g.deleted_at IS NULL`, viewerId, groupId),
  );
  if (!row) return null;
  const members = expectOk(
    await database.all<MemberRow>(
      `SELECT u.id, u.display_name, u.handle, u.avatar_key, u.status, m.role, m.added_at
         FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ? AND u.status IN ('active', 'disabled')
        ORDER BY CASE m.role WHEN 'manager' THEN 0 ELSE 1 END, u.display_name COLLATE NOCASE, u.id`,
      groupId,
    ),
  );
  const list: GroupMember[] = members.map((m) => ({
    id: m.id,
    displayName: m.display_name,
    handle: m.handle,
    avatarUrl: avatarUrl(m.id, m.avatar_key),
    role: m.role === "manager" ? "manager" : "member",
    deactivated: m.status === "disabled",
    addedAt: m.added_at,
  }));
  return { ...toSummary(row), members: list };
}

/** The group's membership of one person, or null when they aren't in it (or it doesn't exist). */
export async function membershipOf(
  db: D1Database,
  groupId: string,
  userId: string,
): Promise<{ role: GroupMemberRole } | null> {
  const row = expectOk(
    await new Database(db).first<{ role: string }>(
      `SELECT m.role FROM group_members m JOIN groups g ON g.id = m.group_id
        WHERE m.group_id = ? AND m.user_id = ? AND g.deleted_at IS NULL`,
      groupId,
      userId,
    ),
  );
  if (!row) return null;
  return { role: row.role === "manager" ? "manager" : "member" };
}

/** Whether a group exists (and isn't deleted). */
export async function groupExists(db: D1Database, groupId: string): Promise<boolean> {
  const row = expectOk(
    await new Database(db).first<{ one: number }>(
      "SELECT 1 AS one FROM groups WHERE id = ? AND deleted_at IS NULL",
      groupId,
    ),
  );
  return row !== null;
}

/**
 * Whether a handle can be a group's: the people rules (shape, reserved words and rows, held handles),
 * except that a group may take back a handle it released itself.
 */
async function groupHandleProblem(
  ctx: CoreContext,
  handle: string,
  groupId: string | null,
): Promise<"invalid" | "reserved" | "taken" | "held" | null> {
  if (groupId) {
    const own = expectOk(
      await new Database(ctx.env.DB).first<{ one: number }>(
        "SELECT 1 AS one FROM handles WHERE handle = ? AND owner_type = 'group' AND owner_id = ?",
        handle,
        groupId,
      ),
    );
    if (own) return null;
  }
  const availability = await handleAvailability(ctx.env.DB, handle, null, ctx.now());
  return availability.available ? null : (availability.reason ?? "taken");
}

/** Frees `handle` for a claim in the same batch: an expired hold, or one this group released. */
function freeHeldForGroup(database: Database, handle: string, now: number, groupId: string) {
  return database.statement(
    `DELETE FROM handles WHERE handle = ?1 AND released_at IS NOT NULL
        AND (released_at <= ?2 OR (owner_type = 'group' AND owner_id = ?3))`,
    handle,
    now - HANDLE_HOLD_MS,
    groupId,
  );
}

/** SQL: the actor may still manage groups (an active owner or admin). `?` is the actor's ID. */
const ACTOR_MANAGES_GROUPS =
  "EXISTS (SELECT 1 FROM users a WHERE a.id = ? AND a.status = 'active' AND a.role IN ('owner', 'admin'))";

async function nameInUse(ctx: CoreContext, name: string, exceptId: string | null): Promise<boolean> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ one: number }>(
      "SELECT 1 AS one FROM groups WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id != ?",
      name,
      exceptId ?? "",
    ),
  );
  return row !== null;
}

/**
 * `POST /groups`. The route has authorized `groups.manage` and, for each named manager, the add
 * (`group.add_member`, so an admin naming themselves needs an owner). Managers must be active members.
 */
export async function createGroup(
  ctx: CoreContext,
  actorId: string,
  body: CreateGroupBody,
): Promise<Result<GroupDetail, ApiError>> {
  const now = ctx.now();
  const id = ulid();
  const name = body.name;
  if (await nameInUse(ctx, name, null)) return err(nameTaken());
  const problem = await groupHandleProblem(ctx, body.handle, null);
  if (problem) return err(handleError(problem));
  const managerIds = [...new Set(body.managerIds ?? [])];

  const database = new Database(ctx.env.DB);
  const statements = [
    freeHeldForGroup(database, body.handle, now, id),
    database.statement(
      `INSERT INTO groups (id, name, handle, description, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${ACTOR_MANAGES_GROUPS}`,
      id,
      name,
      body.handle,
      body.description?.trim() || null,
      actorId,
      now,
      now,
      actorId,
    ),
    database.statement(
      "INSERT INTO handles (handle, owner_type, owner_id) SELECT ?, 'group', ? WHERE EXISTS (SELECT 1 FROM groups WHERE id = ?)",
      body.handle,
      id,
      id,
    ),
    await auditStatement(
      ctx,
      {
        action: "group.created",
        actor: actorId,
        target: { type: "group", id },
        metadata: { name, handle: body.handle, managers: managerIds.length },
      },
      { onlyIfPreviousChanged: true },
    ),
  ];
  for (const managerId of managerIds) {
    statements.push(
      database.statement(
        `INSERT INTO group_members (group_id, user_id, role, added_at)
         SELECT ?, ?, 'manager', ? WHERE EXISTS (SELECT 1 FROM groups WHERE id = ?)
            AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')`,
        id,
        managerId,
        now,
        id,
        managerId,
      ),
      await auditStatement(
        ctx,
        {
          action: "group.member_added",
          actor: actorId,
          target: { type: "group", id },
          metadata: { userId: managerId, role: "manager", selfAdd: managerId === actorId },
        },
        { onlyIfPreviousChanged: true },
      ),
    );
  }
  const result = await database.batchRun(statements);
  if (!result.ok) {
    if (result.error.kind !== "unique") throw new Error(`group create: unexpected ${result.error.kind} failure`);
    // A race: someone took the name or the handle between the checks and the batch.
    if (await nameInUse(ctx, name, null)) return err(nameTaken());
    return err(handleError("taken"));
  }
  if ((result.value[1]?.changes ?? 0) !== 1) {
    return err(apiError("forbidden", "You can't manage groups any more.", { reason: "not_permitted" }));
  }
  const group = await getGroup(ctx, actorId, id);
  if (!group) throw new Error("group create: the new group vanished");
  return ok(group);
}

/** `PATCH /groups/:id`. The route has authorized `groups.manage`. */
export async function updateGroup(
  ctx: CoreContext,
  actorId: string,
  groupId: string,
  body: UpdateGroupBody,
): Promise<Result<GroupDetail, ApiError>> {
  const now = ctx.now();
  const database = new Database(ctx.env.DB);
  const current = expectOk(
    await database.first<{ name: string; handle: string | null; description: string | null }>(
      "SELECT name, handle, description FROM groups WHERE id = ? AND deleted_at IS NULL",
      groupId,
    ),
  );
  if (!current) return err(NO_GROUP);
  const name = body.name ?? current.name;
  if (body.name !== undefined && (await nameInUse(ctx, name, groupId))) return err(nameTaken());
  const handle = body.handle ?? current.handle;
  const handleChanges = body.handle !== undefined && body.handle !== current.handle;
  if (handleChanges && body.handle !== undefined) {
    const problem = await groupHandleProblem(ctx, body.handle, groupId);
    if (problem) return err(handleError(problem));
  }
  const description = body.description === undefined ? current.description : body.description?.trim() || null;

  const fields = [
    ...(body.name !== undefined && body.name !== current.name ? ["name"] : []),
    ...(handleChanges ? ["handle"] : []),
    ...(description !== current.description ? ["description"] : []),
  ];
  if (fields.length === 0) {
    const group = await getGroup(ctx, actorId, groupId);
    return group ? ok(group) : err(NO_GROUP);
  }
  // Every write is conditional on the group (and its handle) still being as read, and on the actor still
  // managing groups, so an actor demoted or disabled meanwhile changes no handle either.
  const still = `EXISTS (SELECT 1 FROM groups WHERE id = ?1 AND deleted_at IS NULL AND handle IS ?2)
    AND ${ACTOR_MANAGES_GROUPS.replace("?", "?4")}`;
  const statements: D1PreparedStatement[] = [];
  if (handleChanges && handle !== null) {
    statements.push(
      freeHeldForGroup(database, handle, now, groupId),
      database.statement(
        `INSERT INTO handles (handle, owner_type, owner_id) SELECT ?3, 'group', ?1 WHERE ${still}`,
        groupId,
        current.handle,
        handle,
        actorId,
      ),
      database.statement(
        `UPDATE handles SET released_at = ?3
          WHERE handle = ?2 AND owner_type = 'group' AND owner_id = ?1 AND released_at IS NULL AND ${still}`,
        groupId,
        current.handle,
        now,
        actorId,
      ),
    );
  }
  const updateIndex = statements.length;
  statements.push(
    database.statement(
      `UPDATE groups SET name = ?3, handle = ?4, description = ?5, updated_at = ?6
        WHERE id = ?1 AND deleted_at IS NULL AND handle IS ?2 AND ${ACTOR_MANAGES_GROUPS.replace("?", "?7")}`,
      groupId,
      current.handle,
      name,
      handle,
      description,
      now,
      actorId,
    ),
    await auditStatement(
      ctx,
      {
        action: "group.updated",
        actor: actorId,
        target: { type: "group", id: groupId },
        metadata: { fields, ...(fields.includes("name") ? { from: current.name, to: name } : {}) },
      },
      { onlyIfPreviousChanged: true },
    ),
  );
  const result = await database.batchRun(statements);
  if (!result.ok) {
    if (result.error.kind !== "unique") throw new Error(`group update: unexpected ${result.error.kind} failure`);
    if (await nameInUse(ctx, name, groupId)) return err(nameTaken());
    return err(handleError("taken"));
  }
  if ((result.value[updateIndex]?.changes ?? 0) !== 1) {
    if (!(await groupExists(ctx.env.DB, groupId))) return err(NO_GROUP);
    return err(apiError("conflict", "The group changed at the same time. Try again.", { reason: "group_changed" }));
  }
  const group = await getGroup(ctx, actorId, groupId);
  return group ? ok(group) : err(NO_GROUP);
}

/**
 * `DELETE /groups/:id`. The route has authorized `groups.manage`. Soft delete: members removed, the
 * handle released (held 30 days), audited with the member count (Platform §4).
 */
export async function deleteGroup(ctx: CoreContext, actorId: string, groupId: string): Promise<Result<null, ApiError>> {
  const now = ctx.now();
  const database = new Database(ctx.env.DB);
  const row = expectOk(
    await database.first<{ name: string; members: number }>(
      `SELECT name, (SELECT count(*) FROM group_members WHERE group_id = groups.id) AS members
         FROM groups WHERE id = ? AND deleted_at IS NULL`,
      groupId,
    ),
  );
  if (!row) return err(NO_GROUP);
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE groups SET deleted_at = ?, updated_at = ?, handle = NULL
          WHERE id = ? AND deleted_at IS NULL AND ${ACTOR_MANAGES_GROUPS}`,
        now,
        now,
        groupId,
        actorId,
      ),
      await auditStatement(
        ctx,
        {
          action: "group.deleted",
          actor: actorId,
          target: { type: "group", id: groupId },
          metadata: { name: row.name, members: row.members },
        },
        { onlyIfPreviousChanged: true },
      ),
      // The rest only once the group is deleted (by this batch or an earlier one).
      database.statement(
        "DELETE FROM group_members WHERE group_id = ? AND EXISTS (SELECT 1 FROM groups WHERE id = ? AND deleted_at IS NOT NULL)",
        groupId,
        groupId,
      ),
      database.statement(
        `UPDATE handles SET released_at = ?
          WHERE owner_type = 'group' AND owner_id = ? AND released_at IS NULL
            AND EXISTS (SELECT 1 FROM groups WHERE id = ? AND deleted_at IS NOT NULL)`,
        now,
        groupId,
        groupId,
      ),
    ]),
  );
  if ((result[0]?.changes ?? 0) !== 1) {
    if (!(await groupExists(ctx.env.DB, groupId))) return err(NO_GROUP);
    return err(apiError("forbidden", "You can't manage groups any more.", { reason: "not_permitted" }));
  }
  return ok(null);
}

/**
 * SQL: the actor may still change this group's membership: an active owner or admin, or an active
 * manager of the group. Placeholders: actor ID, group ID.
 */
const ACTOR_MANAGES_GROUP = `EXISTS (SELECT 1 FROM users a WHERE a.id = ? AND a.status = 'active'
    AND (a.role IN ('owner', 'admin')
         OR EXISTS (SELECT 1 FROM group_members x WHERE x.group_id = ? AND x.user_id = a.id AND x.role = 'manager')))`;

/**
 * Adds someone to a group with `role`. The route has authorized `group.add_member` (and, for a manager,
 * `groups.manage`). Conditional on the group existing, the person being active and the actor still
 * allowed; someone already in the group is left as they are (`changed: false`).
 */
export async function addGroupMember(
  ctx: CoreContext,
  actorId: string,
  groupId: string,
  userId: string,
  role: GroupMemberRole,
): Promise<Result<GroupMembershipResult, ApiError>> {
  const now = ctx.now();
  const database = new Database(ctx.env.DB);
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `INSERT INTO group_members (group_id, user_id, role, added_at)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM groups WHERE id = ? AND deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
            AND ${ACTOR_MANAGES_GROUP}
            -- An admin adding themselves needs an owner (Permissions §6), re-checked here.
            AND NOT (? = ? AND EXISTS (SELECT 1 FROM users s WHERE s.id = ? AND s.role = 'admin'))
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        groupId,
        userId,
        role,
        now,
        groupId,
        userId,
        actorId,
        groupId,
        userId,
        actorId,
        actorId,
      ),
      await auditStatement(
        ctx,
        {
          action: "group.member_added",
          actor: actorId,
          target: { type: "group", id: groupId },
          metadata: { userId, role, selfAdd: userId === actorId },
        },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  if ((result[0]?.changes ?? 0) === 1) return ok({ groupId, userId, role, changed: true });
  const existing = await membershipOf(ctx.env.DB, groupId, userId);
  if (existing) return ok({ groupId, userId, role: existing.role, changed: false });
  if (!(await groupExists(ctx.env.DB, groupId))) return err(NO_GROUP);
  return err(
    apiError("conflict", "Nobody was added: something changed at the same time. Try again.", {
      reason: "group_changed",
    }),
  );
}

/** Appoints or removes a manager (the person stays in the group). The route has authorized `groups.manage`. */
export async function setGroupMemberRole(
  ctx: CoreContext,
  actorId: string,
  groupId: string,
  userId: string,
  from: GroupMemberRole,
  to: GroupMemberRole,
): Promise<Result<GroupMembershipResult, ApiError>> {
  if (from === to) return ok({ groupId, userId, role: to, changed: false });
  const database = new Database(ctx.env.DB);
  // Like an add: only an active member can be made a manager (disabled people stay in, but aren't promoted).
  if (to === "manager") {
    const person = expectOk(await database.first<{ status: string }>("SELECT status FROM users WHERE id = ?", userId));
    if (person?.status !== "active") {
      return err(apiError("forbidden", "That person can't be changed.", { reason: "invalid_target" }));
    }
  }
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE group_members SET role = ?
          WHERE group_id = ? AND user_id = ? AND role = ?
            AND EXISTS (SELECT 1 FROM groups WHERE id = ? AND deleted_at IS NULL)
            AND (? = 'member' OR EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.status = 'active'))
            AND ${ACTOR_MANAGES_GROUPS}`,
        to,
        groupId,
        userId,
        from,
        groupId,
        to,
        userId,
        actorId,
      ),
      await auditStatement(
        ctx,
        {
          action: "group.member_role_changed",
          actor: actorId,
          target: { type: "group", id: groupId },
          metadata: { userId, from, to },
        },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  if ((result[0]?.changes ?? 0) === 1) return ok({ groupId, userId, role: to, changed: true });
  return err(apiError("conflict", "The membership changed at the same time. Try again.", { reason: "group_changed" }));
}

/** `DELETE /groups/:id/members/:userId`. The route has authorized `group.remove_member`. */
export async function removeGroupMember(
  ctx: CoreContext,
  actorId: string,
  groupId: string,
  userId: string,
): Promise<Result<null, ApiError>> {
  const database = new Database(ctx.env.DB);
  const before = await membershipOf(ctx.env.DB, groupId, userId);
  if (!before) return err(apiError("not_found", "This person isn't in the group.", { reason: "not_a_member" }));
  const result = expectOk(
    await database.batchRun([
      database.statement(
        // A non-admin manager may remove members and themselves, never another manager (the engine's
        // rule, re-checked here against the membership as it is now).
        `DELETE FROM group_members
          WHERE group_id = ?1 AND user_id = ?2
            AND EXISTS (SELECT 1 FROM users a WHERE a.id = ?3 AND a.status = 'active'
              AND (a.role IN ('owner', 'admin')
                   OR (EXISTS (SELECT 1 FROM group_members x WHERE x.group_id = ?1 AND x.user_id = a.id AND x.role = 'manager')
                       AND (group_members.role = 'member' OR group_members.user_id = a.id))))`,
        groupId,
        userId,
        actorId,
      ),
      await auditStatement(
        ctx,
        {
          action: "group.member_removed",
          actor: actorId,
          target: { type: "group", id: groupId },
          metadata: { userId, role: before.role, self: userId === actorId },
        },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  if ((result[0]?.changes ?? 0) === 1) return ok(null);
  if (!(await membershipOf(ctx.env.DB, groupId, userId))) {
    return err(apiError("not_found", "This person isn't in the group.", { reason: "not_a_member" }));
  }
  return err(apiError("conflict", "The membership changed at the same time. Try again.", { reason: "group_changed" }));
}

/** The groups a set of people are in (not deleted), by user, sorted by name. For lists and profiles. */
export async function groupsOfUsers(
  db: D1Database,
  userIds: readonly string[],
): Promise<Map<string, { id: string; name: string; handle: string | null }[]>> {
  const out = new Map<string, { id: string; name: string; handle: string | null }[]>();
  if (userIds.length === 0) return out;
  const rows = expectOk(
    await new Database(db).all<{ user_id: string; id: string; name: string; handle: string | null }>(
      `SELECT m.user_id, g.id, g.name, g.handle FROM group_members m JOIN groups g ON g.id = m.group_id
        WHERE g.deleted_at IS NULL AND m.user_id IN (SELECT value FROM json_each(?))
        ORDER BY g.name COLLATE NOCASE, g.id`,
      JSON.stringify(userIds),
    ),
  );
  for (const row of rows) {
    const list = out.get(row.user_id) ?? [];
    list.push({ id: row.id, name: row.name, handle: row.handle });
    out.set(row.user_id, list);
  }
  return out;
}

const groupIdsSchema = z.array(z.string());

/** An invitation's `group_ids` JSON, or none. */
export function parseGroupIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = groupIdsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Every group that isn't deleted, by ID. */
export async function liveGroupNames(db: D1Database): Promise<Map<string, { name: string; handle: string | null }>> {
  const rows = expectOk(
    await new Database(db).all<{ id: string; name: string; handle: string | null }>(
      "SELECT id, name, handle FROM groups WHERE deleted_at IS NULL",
    ),
  );
  return new Map(rows.map((r) => [r.id, { name: r.name, handle: r.handle }]));
}

/**
 * The statement that adds a new member to the groups their invitation named (Identity §4.2; M1e), in the
 * batch that finishes the accept: groups deleted meanwhile are skipped, and running it again adds nothing.
 */
export function joinInvitationGroupsStatement(
  database: Database,
  invitationId: string,
  userId: string,
  now: number,
): D1PreparedStatement {
  return database.statement(
    `INSERT OR IGNORE INTO group_members (group_id, user_id, role, added_at)
     SELECT g.id, ?2, 'member', ?3 FROM groups g
      WHERE g.deleted_at IS NULL
        AND g.id IN (SELECT value FROM json_each((SELECT coalesce(group_ids, '[]') FROM invitations WHERE id = ?1)))
        AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND status = 'active')
        -- Only once this invitation's accept (or its repair) has recorded this user.
        AND EXISTS (SELECT 1 FROM invitations WHERE id = ?1 AND accepted_by = ?2)`,
    invitationId,
    userId,
    now,
  );
}
