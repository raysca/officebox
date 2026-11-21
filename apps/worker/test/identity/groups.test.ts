import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ulid } from "../../src/core/ids";
import type { CoreContext } from "../../src/core/context";
import { rootLogger } from "../../src/core/log";
import { addGroupMember, updateGroup } from "../../src/features/identity/groups";
import { SoftAuthenticator } from "./authenticator";
import {
  addMember,
  Browser,
  fragmentToken,
  invite,
  meetInviteGate,
  registerPasskey,
  setupWorkspace,
  uniqueEmail,
  uniqueHandle,
  type Workspace,
} from "./helpers";
import { auditCount, count } from "./m1c-helpers";

/**
 * M1e groups through HTTP (Identity §4.9, §4.10, §9 "Groups", "Directory", "Handles"; Permissions §4.6, §6,
 * §11 "Admin powers"; Platform §4 "Group → delete").
 */

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
  await meetInviteGate(ws);
});

interface ErrorBody {
  error: { code: string; reason?: string; fields?: Record<string, string[]> };
}
interface Group {
  id: string;
  name: string;
  handle: string | null;
  memberCount: number;
  managerCount: number;
  youManage: boolean;
  members: { id: string; role: string; deactivated: boolean }[];
}

function create(browser: Browser, body: Record<string, unknown> = {}) {
  return browser.json<Group & ErrorBody>("/api/groups", {
    body: { name: `Group ${ulid()}`, handle: uniqueHandle("g"), ...body },
  });
}
const put = (browser: Browser, groupId: string, userId: string, role?: "manager" | "member") =>
  browser.json<ErrorBody & { role?: string; changed?: boolean }>(`/api/groups/${groupId}/members/${userId}`, {
    method: "PUT",
    body: role ? { role } : {},
  });
const drop = (browser: Browser, groupId: string, userId: string) =>
  browser.json<ErrorBody>(`/api/groups/${groupId}/members/${userId}`, { method: "DELETE" });
const detail = (browser: Browser, groupId: string) => browser.json<Group & ErrorBody>(`/api/groups/${groupId}`);

describe("creating, renaming and deleting groups: admins and owners (Permissions §4.6)", () => {
  it("owners and admins create groups; members can't; everyone can see them", async () => {
    const admin = await addMember("admin");
    const member = await addMember("member");
    const byMember = await create(member.browser);
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.reason).toBe("not_permitted");

    const byAdmin = await create(admin.browser, { description: "Designers" });
    expect(byAdmin.status).toBe(201);
    expect(byAdmin.body).toMatchObject({ memberCount: 0, members: [] });
    expect(await auditCount("group.created", byAdmin.body.id)).toBe(1);
    expect((await create(ws.browser)).status).toBe(201);

    const list = await member.browser.json<{ groups: Group[] }>("/api/groups");
    expect(list.status).toBe(200);
    expect(list.body.groups.map((g) => g.id)).toContain(byAdmin.body.id);
    expect((await detail(member.browser, byAdmin.body.id)).status).toBe(200);
    expect((await detail(member.browser, ulid())).status).toBe(404);
  });

  it("names are unique among live groups; handles share the people namespace and its reserved words", async () => {
    const first = await create(ws.browser);
    const sameName = await create(ws.browser, { name: first.body.name.toUpperCase() });
    expect(sameName.status).toBe(409);
    expect(sameName.body.error.reason).toBe("group_name_taken");

    const owner = await env.DB.prepare("SELECT handle FROM users WHERE id = ?")
      .bind(ws.ownerId)
      .first<{ handle: string }>();
    const personHandle = await create(ws.browser, { handle: owner!.handle });
    expect(personHandle.status).toBe(409);
    expect(personHandle.body.error.reason).toBe("handle_taken");
    expect((await create(ws.browser, { handle: "everyone" })).body.error.reason).toBe("handle_reserved");
    expect((await create(ws.browser, { handle: "butler" })).body.error.reason).toBe("handle_reserved");
    expect((await create(ws.browser, { handle: "x" })).body.error.reason).toBe("handle_invalid");
    // And a group's handle can't then be a person's.
    const avail = await ws.browser.json<{ available: boolean; reason?: string }>(
      `/api/handles/${first.body.handle}/available`,
    );
    expect(avail.body).toMatchObject({ available: false, reason: "taken" });
  });

  it("renaming changes the handle and holds the old one for 30 days; the group may take it back", async () => {
    const group = await create(ws.browser);
    const old = group.body.handle!;
    const next = uniqueHandle("renamed");
    const renamed = await ws.browser.json<Group>(`/api/groups/${group.body.id}`, {
      method: "PATCH",
      body: { name: `Renamed ${ulid()}`, handle: next },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.handle).toBe(next);
    expect(await auditCount("group.updated", group.body.id)).toBe(1);
    const held = await ws.browser.json<{ available: boolean; reason?: string }>(`/api/handles/${old}/available`);
    expect(held.body).toMatchObject({ available: false, reason: "held" });
    expect((await create(ws.browser, { handle: old })).body.error.reason).toBe("handle_held");
    const back = await ws.browser.json<Group>(`/api/groups/${group.body.id}`, {
      method: "PATCH",
      body: { handle: old },
    });
    expect(back.body.handle).toBe(old);

    const admin = await addMember("admin");
    expect(
      (await admin.browser.json(`/api/groups/${group.body.id}`, { method: "PATCH", body: { description: "x" } }))
        .status,
    ).toBe(200);
    const member = await addMember("member");
    expect(
      (
        await member.browser.json<ErrorBody>(`/api/groups/${group.body.id}`, {
          method: "PATCH",
          body: { name: "Nope" },
        })
      ).body.error.reason,
    ).toBe("not_permitted");
  });

  it("deleting removes the members, releases the handle (held), is audited, and frees the name", async () => {
    const group = await create(ws.browser);
    const member = await addMember("member");
    await put(ws.browser, group.body.id, member.id);
    const someone = await addMember("member");
    expect((await someone.browser.json<ErrorBody>(`/api/groups/${group.body.id}`, { method: "DELETE" })).status).toBe(
      403,
    );

    const res = await ws.browser.json(`/api/groups/${group.body.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM group_members WHERE group_id = ?", group.body.id)).toBe(0);
    expect(await auditCount("group.deleted", group.body.id)).toBe(1);
    expect((await detail(ws.browser, group.body.id)).status).toBe(404);
    expect((await ws.browser.json(`/api/groups/${group.body.id}`, { method: "DELETE" })).status).toBe(404);
    const held = await ws.browser.json<{ reason?: string }>(`/api/handles/${group.body.handle}/available`);
    expect(held.body.reason).toBe("held");
    expect((await create(ws.browser, { name: group.body.name })).status).toBe(201);
    // Nobody can be added to a deleted group.
    expect((await put(ws.browser, group.body.id, member.id)).status).toBe(404);
  });
});

describe("group membership (Identity §4.9, §9 'Groups'; Permissions §4.6, §6)", () => {
  it("an admin adding themselves gets 403; an owner adding an admin succeeds and is audited", async () => {
    const admin = await addMember("admin");
    const group = await create(admin.browser);
    const self = await put(admin.browser, group.body.id, admin.id);
    expect(self.status).toBe(403);
    expect(self.body.error.reason).toBe("owner_required");
    // Naming themselves a manager at creation is the same add.
    expect((await create(admin.browser, { managerIds: [admin.id] })).body.error.reason).toBe("owner_required");

    const byOwner = await put(ws.browser, group.body.id, admin.id);
    expect(byOwner.status).toBe(200);
    expect(byOwner.body).toMatchObject({ role: "member", changed: true });
    const entry = await env.DB.prepare(
      "SELECT actor_id, metadata FROM audit_log WHERE action = 'group.member_added' AND target_id = ? ORDER BY created_at DESC",
    )
      .bind(group.body.id)
      .first<{ actor_id: string; metadata: string }>();
    expect(entry?.actor_id).toBe(ws.ownerId);
    expect(JSON.parse(entry!.metadata)).toMatchObject({ userId: admin.id, role: "member", selfAdd: false });
    // An owner adding themselves is fine.
    expect((await put(ws.browser, group.body.id, ws.ownerId)).status).toBe(200);
    // Adding someone already in the group changes nothing.
    expect((await put(ws.browser, group.body.id, admin.id)).body).toMatchObject({ changed: false });
  });

  it("group managers manage only their own group's members, and can't appoint or remove managers", async () => {
    const manager = await addMember("member");
    const otherManager = await addMember("member");
    const member = await addMember("member");
    const outsider = await addMember("member");
    const group = await create(ws.browser, { managerIds: [manager.id, otherManager.id] });
    expect(group.status).toBe(201);
    expect(group.body.managerCount).toBe(2);
    const other = await create(ws.browser);

    // Their own group: add and remove members.
    expect((await put(manager.browser, group.body.id, member.id)).status).toBe(200);
    expect(await auditCount("group.member_added", group.body.id)).toBe(3);
    expect((await drop(manager.browser, group.body.id, member.id)).status).toBe(200);
    expect(await auditCount("group.member_removed", group.body.id)).toBe(1);
    // Another group: refused.
    expect((await put(manager.browser, other.body.id, member.id)).body.error.reason).toBe("not_permitted");
    // A plain member: refused.
    expect((await put(outsider.browser, group.body.id, member.id)).body.error.reason).toBe("not_permitted");
    expect((await drop(outsider.browser, group.body.id, manager.id)).body.error.reason).toBe("not_permitted");
    // Appointing a manager, or removing another manager, needs an admin.
    expect((await put(manager.browser, group.body.id, member.id, "manager")).body.error.reason).toBe("not_permitted");
    expect((await drop(manager.browser, group.body.id, otherManager.id)).body.error.reason).toBe("not_permitted");
    expect((await put(manager.browser, group.body.id, otherManager.id, "member")).body.error.reason).toBe(
      "not_permitted",
    );
    // An admin appoints and un-appoints managers.
    const appointed = await put(ws.browser, group.body.id, member.id, "manager");
    expect(appointed.body).toMatchObject({ role: "manager", changed: true });
    expect((await put(ws.browser, group.body.id, member.id, "member")).body).toMatchObject({ role: "member" });
    // The appointment re-added them (an add, audited as one); making them a member again is a role change.
    expect(await auditCount("group.member_role_changed", group.body.id)).toBe(1);
    // A manager may leave the group themselves.
    expect((await drop(manager.browser, group.body.id, manager.id)).status).toBe(200);
    // Once out, they manage nothing.
    expect((await put(manager.browser, group.body.id, outsider.id)).body.error.reason).toBe("not_permitted");
  });

  it("disabled and deleted people can't be added; removing someone not in the group is 404", async () => {
    const group = await create(ws.browser);
    const disabled = await addMember("member");
    await ws.browser.json(`/api/admin/members/${disabled.id}`, { method: "PATCH", body: { status: "disabled" } });
    expect((await put(ws.browser, group.body.id, disabled.id)).body.error.reason).toBe("invalid_target");
    const gone = await addMember("member");
    await ws.browser.json(`/api/admin/members/${gone.id}`, { method: "DELETE" });
    expect((await put(ws.browser, group.body.id, gone.id)).body.error.reason).toBe("invalid_target");
    expect((await put(ws.browser, group.body.id, ulid())).status).toBe(404);
    expect((await drop(ws.browser, group.body.id, disabled.id)).status).toBe(404);
    expect((await put(ws.browser, group.body.id, "nope")).status).toBe(404);
  });
});

describe("groups in the directory and on profiles (Identity §4.10, §9 'Directory'; M1d placeholders)", () => {
  it("profiles list groups; search matches a group's name or handle; the group filter keeps its members", async () => {
    const member = await addMember("member");
    const other = await addMember("member");
    const name = `Orbit ${ulid().slice(-6)}`;
    const group = await create(ws.browser, { name });
    await put(ws.browser, group.body.id, member.id);

    const profile = await other.browser.json<{ groups: { id: string; name: string; handle: string }[] }>(
      `/api/members/${member.id}`,
    );
    expect(profile.body.groups).toEqual([{ id: group.body.id, name, handle: group.body.handle }]);
    type Page = { members: { id: string }[] };
    const byName = await other.browser.json<Page>(`/api/members?q=${encodeURIComponent(name.toLowerCase())}`);
    expect(byName.body.members.map((m) => m.id)).toEqual([member.id]);
    const byHandle = await other.browser.json<Page>(`/api/members?q=@${group.body.handle}`);
    expect(byHandle.body.members.map((m) => m.id)).toEqual([member.id]);
    const filtered = await other.browser.json<Page>(`/api/members?group=${group.body.id}`);
    expect(filtered.body.members.map((m) => m.id)).toEqual([member.id]);
    expect((await other.browser.json(`/api/members?group=not-an-id`)).status).toBe(400);
    const mine = await member.browser.json<{ groups: { id: string }[] }>("/api/me/profile");
    expect(mine.body.groups.map((g) => g.id)).toEqual([group.body.id]);
  });
});

describe("invitations with groups (Identity §4.2)", () => {
  it("the invitee joins the invitation's groups on accepting, skipping one deleted meanwhile", async () => {
    const keep = await create(ws.browser);
    const doomed = await create(ws.browser);
    const email = uniqueEmail("grouped");
    const created = await ws.browser.json<{ link: string; invitation: { groups: { id: string }[] } }>(
      "/api/admin/invitations",
      { body: { email, role: "member", sendEmail: false, groupIds: [keep.body.id, doomed.body.id] } },
    );
    expect(created.status).toBe(201);
    expect(created.body.invitation.groups.map((g) => g.id).sort()).toEqual([keep.body.id, doomed.body.id].sort());
    await ws.browser.json(`/api/groups/${doomed.body.id}`, { method: "DELETE" });

    const browser = new Browser();
    const accepted = await browser.json("/api/invitations/accept", {
      body: { token: fragmentToken(created.body.link), name: "Gia Roup", handle: uniqueHandle("gia") },
    });
    expect(accepted.status).toBe(201);
    expect((await registerPasskey(browser, new SoftAuthenticator())).verify?.status).toBe(200);
    const id = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())!.id;
    const groups = await env.DB.prepare("SELECT group_id FROM group_members WHERE user_id = ?")
      .bind(id)
      .all<{ group_id: string }>();
    expect(groups.results.map((r) => r.group_id)).toEqual([keep.body.id]);
  });

  it("an unknown group is refused before anything is created", async () => {
    const res = await ws.browser.json<ErrorBody>("/api/admin/invitations", {
      body: { email: uniqueEmail("nogroup"), role: "member", sendEmail: false, groupIds: [ulid()] },
    });
    expect(res.status).toBe(404);
    expect(res.body.error.reason).toBe("unknown_group");
    expect((await invite(ws.browser, uniqueEmail("plain"))).status).toBe(201);
  });
});

describe("review fixes (M1e)", () => {
  const ctx = (): CoreContext => ({ env, log: rootLogger, now: () => Date.now() });

  it("a rename by an admin demoted between the check and the write changes neither the group nor any handle", async () => {
    const admin = await addMember("admin");
    const group = await create(ws.browser);
    const next = uniqueHandle("late");
    // The route authorized the admin; then they're demoted before the batch runs.
    await env.DB.prepare("UPDATE users SET role = 'member' WHERE id = ?").bind(admin.id).run();
    const result = await updateGroup(ctx(), admin.id, group.body.id, { handle: next });
    expect(result.ok).toBe(false);
    expect(await count("SELECT count(*) AS n FROM handles WHERE handle = ?", next)).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM handles WHERE handle = ? AND owner_id = ? AND released_at IS NULL",
        group.body.handle,
        group.body.id,
      ),
    ).toBe(1);
    expect((await detail(ws.browser, group.body.id)).body.handle).toBe(group.body.handle);
  });

  it("a disabled member can't be made a manager", async () => {
    const group = await create(ws.browser);
    const member = await addMember("member");
    await put(ws.browser, group.body.id, member.id);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    const res = await put(ws.browser, group.body.id, member.id, "manager");
    expect(res.status).toBe(403);
    expect(res.body.error.reason).toBe("invalid_target");
    // Making a manager a plain member is still fine for a disabled person.
    await env.DB.prepare("UPDATE group_members SET role = 'manager' WHERE group_id = ? AND user_id = ?")
      .bind(group.body.id, member.id)
      .run();
    expect((await put(ws.browser, group.body.id, member.id, "member")).status).toBe(200);
  });

  it("the write itself refuses an admin adding themselves, even past the route", async () => {
    const admin = await addMember("admin");
    const group = await create(ws.browser);
    const result = await addGroupMember(ctx(), admin.id, group.body.id, admin.id, "member");
    expect(result.ok).toBe(false);
    expect(await count("SELECT count(*) AS n FROM group_members WHERE user_id = ?", admin.id)).toBe(0);
  });

  it("an invitation's groups are joined only by the user its accept recorded", async () => {
    const group = await create(ws.browser);
    const stranger = await addMember("member");
    const created = await ws.browser.json<{ invitation: { id: string } }>("/api/admin/invitations", {
      body: { email: uniqueEmail("g"), role: "member", sendEmail: false, groupIds: [group.body.id] },
    });
    // Run the join statement for someone the invitation wasn't accepted by: nothing happens.
    const { Database } = await import("../../src/core/db");
    const { joinInvitationGroupsStatement } = await import("../../src/features/identity/groups");
    const database = new Database(env.DB);
    await database.batchRun([
      joinInvitationGroupsStatement(database, created.body.invitation.id, stranger.id, Date.now()),
    ]);
    expect(await count("SELECT count(*) AS n FROM group_members WHERE user_id = ?", stranger.id)).toBe(0);
  });
});
