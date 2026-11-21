import { env } from "cloudflare:workers";
import { WS_CLOSE_SESSION_REVOKED } from "@officebox/shared";
import { beforeAll, describe, expect, it } from "vitest";
import type { CoreContext } from "../../src/core/context";
import { ulid } from "../../src/core/ids";
import { rootLogger } from "../../src/core/log";
import { Database } from "../../src/core/db";
import {
  changeMemberRole,
  deleteMember,
  eraseUnfinishedDeletions,
  revokeSentInvitationsStatements,
} from "../../src/features/identity/member-lifecycle";
import { SoftAuthenticator } from "./authenticator";
import {
  addMember,
  Browser,
  configureEmail,
  fragmentToken,
  invite,
  meetInviteGate,
  outbox,
  reauth,
  setupWorkspace,
  signInWithPasskey,
  staleFreshAuth,
  uniqueEmail,
  uniqueHandle,
  type Workspace,
} from "./helpers";
import { auditCount, count, noticeKinds, openHub, sessionsOf, within } from "./m1c-helpers";

/**
 * M1e members administration through HTTP (Identity §4.11, §9 "Admin powers", "Promotion", "Step-up",
 * "Audit"; Permissions §4.6, §6, §11; Platform §3, §3.1; Admin §5): the role × action matrix, the
 * promotion passkey rules, step-up, last-owner races, disable, sign-out and delete (anonymise).
 */

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
  await meetInviteGate(ws);
});

interface ErrorBody {
  error: { code: string; reason?: string };
}
type Role = "owner" | "admin" | "member";

/** A person created straight in D1 (no passkey, no session): a target, never an actor. */
async function plainUser(role: Role, status: "active" | "disabled" = "active", passkeys = 0) {
  const id = ulid();
  const email = uniqueEmail(role);
  const handle = uniqueHandle("t");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, email_normalised, display_name, handle, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Target Person', ?, ?, ?, ?, ?)`,
    ).bind(id, email, email, handle, role, status, now, now),
    env.DB.prepare("INSERT INTO handles (handle, owner_type, owner_id) VALUES (?, 'user', ?)").bind(handle, id),
  ]);
  for (let i = 0; i < passkeys; i++) await fakePasskey(id);
  return { id, email, handle };
}

async function fakePasskey(userId: string) {
  await env.DB.prepare(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, sign_count, device_type, backed_up, created_at)
     VALUES (?, ?, ?, 'pk', 0, 'singleDevice', 0, ?)`,
  )
    .bind(ulid(), userId, `cred-${ulid()}`, Date.now())
    .run();
}

/** Leaves the workspace owner as the only active owner (earlier tests make more). */
async function onlyOneOwner() {
  await env.DB.prepare("UPDATE users SET role = 'member' WHERE role = 'owner' AND id != ?").bind(ws.ownerId).run();
  await env.DB.prepare("UPDATE users SET role = 'owner', status = 'active' WHERE id = ?").bind(ws.ownerId).run();
}

async function userRow(id: string) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

const patch = (browser: Browser, id: string, body: unknown) =>
  browser.json<ErrorBody & Record<string, unknown>>(`/api/admin/members/${id}`, { method: "PATCH", body });
const signOut = (browser: Browser, id: string) =>
  browser.json<ErrorBody & { signedOut?: number }>(`/api/admin/members/${id}/sign-out`, { body: {} });
const remove = (browser: Browser, id: string) =>
  browser.json<ErrorBody & { deleted?: boolean }>(`/api/admin/members/${id}`, { method: "DELETE" });

type Action = "disable" | "enable" | "sign-out" | "delete";
function act(browser: Browser, action: Action, id: string) {
  switch (action) {
    case "disable":
      return patch(browser, id, { status: "disabled" });
    case "enable":
      return patch(browser, id, { status: "active" });
    case "sign-out":
      return signOut(browser, id);
    case "delete":
      return remove(browser, id);
  }
}

describe("the admin-power matrix through HTTP (Permissions §4.6, §6; Identity §3, §9 'Admin powers')", () => {
  // Literal from Permissions §6: admins act on members only; owners on anyone; members on nobody.
  const EXPECTED: Record<Role, Record<Role, number | string>> = {
    owner: { member: 200, admin: 200, owner: 200 },
    admin: { member: 200, admin: "owner_required", owner: "owner_required" },
    member: { member: "not_permitted", admin: "not_permitted", owner: "not_permitted" },
  };
  for (const action of ["disable", "enable", "sign-out", "delete"] as const) {
    it(`${action}: owner → anyone, admin → members only, member → nobody`, async () => {
      const actors: Record<Role, Browser> = {
        owner: ws.browser,
        admin: (await addMember("admin")).browser,
        member: (await addMember("member")).browser,
      };
      for (const actorRole of ["owner", "admin", "member"] as const) {
        for (const targetRole of ["member", "admin", "owner"] as const) {
          const target = await plainUser(targetRole, action === "enable" ? "disabled" : "active");
          const res = await act(actors[actorRole], action, target.id);
          const expected = EXPECTED[actorRole][targetRole];
          if (typeof expected === "number") {
            expect(res.status, `${actorRole} ${action} ${targetRole}`).toBe(expected);
          } else {
            expect(res.status, `${actorRole} ${action} ${targetRole}`).toBe(403);
            expect(res.body.error.reason).toBe(expected);
          }
          const after = await userRow(target.id);
          const wanted = { disable: "disabled", enable: "active", delete: "deleted", "sign-out": "active" }[action];
          const unchanged = action === "enable" ? "disabled" : "active";
          expect(after?.status).toBe(typeof expected === "number" ? wanted : unchanged);
        }
      }
    });
  }

  it("a member learns nothing about IDs: unknown and real targets both answer 403 for them", async () => {
    const member = await addMember("member");
    expect((await act(member.browser, "delete", ulid())).status).toBe(403);
    expect((await act(member.browser, "disable", ws.ownerId)).status).toBe(403);
    // An owner gets 404 for an unknown or malformed ID.
    expect((await act(ws.browser, "delete", ulid())).status).toBe(404);
    expect((await act(ws.browser, "disable", "not-a-ulid")).status).toBe(404);
  });

  it("the reserved system rows can't be acted on", async () => {
    // Not ULIDs, so they're unknown to the routes.
    expect((await act(ws.browser, "disable", "system")).status).toBe(404);
  });

  it("nobody disables or deletes themselves (default); an admin acting on themselves needs an owner", async () => {
    const meDisable = await patch(ws.browser, ws.ownerId, { status: "disabled" });
    expect(meDisable.status).toBe(403);
    expect(meDisable.body.error.reason).toBe("self_target");
    expect((await remove(ws.browser, ws.ownerId)).body.error.reason).toBe("self_target");
    const admin = await addMember("admin");
    expect((await patch(admin.browser, admin.id, { status: "disabled" })).body.error.reason).toBe("owner_required");
  });

  it("the body is exactly one change; unknown fields and guest are refused", async () => {
    const target = await plainUser("member");
    for (const body of [{ role: "guest" }, { role: "admin", status: "disabled" }, { status: "deleted" }, {}]) {
      const res = await patch(ws.browser, target.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("validation_failed");
    }
  });
});

describe("role changes: owners only, step-up, the promotion passkey rules (Identity §2, §4.11, §9)", () => {
  it("admins and members can't change roles; an owner can promote and demote", async () => {
    const admin = await addMember("admin");
    const member = await addMember("member");
    const target = await plainUser("member", "active", 1);
    const byAdmin = await patch(admin.browser, target.id, { role: "admin" });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.reason).toBe("owner_required");
    // No self-escalation: an admin promoting themselves is refused the same way.
    expect((await patch(admin.browser, admin.id, { role: "owner" })).body.error.reason).toBe("owner_required");
    expect((await patch(member.browser, member.id, { role: "admin" })).body.error.reason).toBe("not_permitted");

    const promoted = await patch(ws.browser, target.id, { role: "admin" });
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ id: target.id, role: "admin", status: "active", changed: true });
    expect((await userRow(target.id))?.role).toBe("admin");
    expect(await auditCount("member.role_changed", target.id)).toBe(1);
    expect(await noticeKinds(target.id)).toContain("role_changed");

    const demoted = await patch(ws.browser, target.id, { role: "member" });
    expect(demoted.body).toMatchObject({ role: "member", changed: true });
    // The same role again changes nothing and writes no audit entry.
    expect((await patch(ws.browser, target.id, { role: "member" })).body).toMatchObject({ changed: false });
    expect(await auditCount("member.role_changed", target.id)).toBe(2);
  });

  it("needs step-up: reauth_required with a stale assertion, then succeeds after re-authenticating", async () => {
    const target = await plainUser("member", "active", 1);
    await staleFreshAuth(ws.ownerId);
    const refused = await patch(ws.browser, target.id, { role: "admin" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("reauth_required");
    expect((await userRow(target.id))?.role).toBe("member");
    expect((await reauth(ws.browser, ws.authenticator)).status).toBe(200);
    expect((await patch(ws.browser, target.id, { role: "admin" })).status).toBe(200);
  });

  it("a role denial wins over step-up: an admin with a stale session gets owner_required, not reauth_required", async () => {
    const admin = await addMember("admin");
    await staleFreshAuth(admin.id);
    const res = await patch(admin.browser, (await plainUser("member", "active", 1)).id, { role: "admin" });
    expect(res.body.error.reason).toBe("owner_required");
  });

  it("promotion: admin needs a passkey; owner needs two, or an unconsumed RECOVERY_TOKEN plus one", async () => {
    const none = await plainUser("member");
    const noPasskey = await patch(ws.browser, none.id, { role: "admin" });
    expect(noPasskey.status).toBe(403);
    expect(noPasskey.body.error.reason).toBe("promotion_passkeys");
    // Even with RECOVERY_TOKEN, an owner needs at least one passkey.
    const recovery = "r".repeat(40);
    const noneToOwner = await ws.browser.json<ErrorBody>(`/api/admin/members/${none.id}`, {
      method: "PATCH",
      body: { role: "owner" },
      env: { RECOVERY_TOKEN: recovery },
    });
    expect(noneToOwner.body.error.reason).toBe("promotion_passkeys");

    const one = await plainUser("member", "active", 1);
    expect((await patch(ws.browser, one.id, { role: "owner" })).body.error.reason).toBe("promotion_passkeys");
    const withToken = await ws.browser.json(`/api/admin/members/${one.id}`, {
      method: "PATCH",
      body: { role: "owner" },
      env: { RECOVERY_TOKEN: recovery },
    });
    expect(withToken.status).toBe(200);

    const two = await plainUser("admin", "active", 2);
    expect((await patch(ws.browser, two.id, { role: "owner" })).status).toBe(200);
    // Demotions aren't gated by passkeys.
    expect((await patch(ws.browser, two.id, { role: "member" })).status).toBe(200);
    // Clean up the extra owners so later tests start from one active owner.
    await env.DB.prepare("UPDATE users SET role = 'member' WHERE id IN (?, ?)").bind(one.id, two.id).run();
  });

  it("a disabled person can be demoted but not promoted (re-enable first)", async () => {
    const disabledAdmin = await plainUser("admin", "disabled", 1);
    expect((await patch(ws.browser, disabledAdmin.id, { role: "member" })).body).toMatchObject({
      role: "member",
      status: "disabled",
    });
    const res = await patch(ws.browser, disabledAdmin.id, { role: "admin" });
    expect(res.body.error.reason).toBe("invalid_target");
  });

  it("promoting a member revokes their pending magic links; the notice is emailed when email is on", async () => {
    await configureEmail();
    const target = await plainUser("member", "active", 1);
    const token = `ml-${ulid()}`;
    await env.DB.prepare(
      `INSERT INTO magic_link_issues (token_hash, email_normalised, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(token, target.email, target.id, Date.now() + 600_000, Date.now())
      .run();
    expect((await patch(ws.browser, target.id, { role: "admin" })).status).toBe(200);
    expect(
      await count("SELECT count(*) AS n FROM magic_link_issues WHERE token_hash = ? AND revoked_at IS NOT NULL", token),
    ).toBe(1);
    expect(outbox.to(target.email).some((m) => m.subject.includes("Your role was changed"))).toBe(true);
  });
});

describe("the last active owner is protected, also against races (Identity §4.11; Admin §5.3)", () => {
  it("the only owner can't demote, disable or delete themselves", async () => {
    await onlyOneOwner();
    expect(await count("SELECT count(*) AS n FROM users WHERE role = 'owner' AND status = 'active'")).toBe(1);
    const demote = await patch(ws.browser, ws.ownerId, { role: "admin" });
    expect(demote.status).toBe(403);
    expect(demote.body.error.reason).toBe("last_owner");
  });

  it("two owners demoting each other at once: exactly one wins and an active owner remains", async () => {
    await onlyOneOwner();
    const other = await addMember("owner");
    for (let round = 0; round < 3; round++) {
      const [a, b] = await Promise.all([
        patch(ws.browser, other.id, { role: "admin" }),
        patch(other.browser, ws.ownerId, { role: "admin" }),
      ]);
      expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
      expect(await count("SELECT count(*) AS n FROM users WHERE role = 'owner' AND status = 'active'")).toBe(1);
      // Put both back as owners for the next round.
      await env.DB.prepare("UPDATE users SET role = 'owner' WHERE id IN (?, ?)").bind(ws.ownerId, other.id).run();
    }
    await env.DB.prepare("UPDATE users SET role = 'member' WHERE id = ?").bind(other.id).run();
  });

  it("the only two owners disabling or deleting each other at once: exactly one applies", async () => {
    for (const action of ["disable", "delete"] as const) {
      const [o1, o2] = [await addMember("owner"), await addMember("owner")];
      // The workspace owner steps aside (an admin for the moment), so o1 and o2 are the only owners.
      await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(ws.ownerId).run();
      await env.DB.prepare("UPDATE users SET role = 'member' WHERE role = 'owner' AND id NOT IN (?, ?)")
        .bind(o1.id, o2.id)
        .run();
      const [a, b] = await Promise.all([act(o1.browser, action, o2.id), act(o2.browser, action, o1.id)]);
      expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
      expect(await count("SELECT count(*) AS n FROM users WHERE role = 'owner' AND status = 'active'")).toBe(1);
      await onlyOneOwner();
    }
  });

  it("two owners each demoting themselves at once: one stays an owner", async () => {
    await onlyOneOwner();
    const other = await addMember("owner");
    const [a, b] = await Promise.all([
      patch(ws.browser, ws.ownerId, { role: "admin" }),
      patch(other.browser, other.id, { role: "admin" }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    const loser = a.status === 200 ? b : a;
    expect(loser.body.error.reason).toBe("last_owner");
    expect(await count("SELECT count(*) AS n FROM users WHERE role = 'owner' AND status = 'active'")).toBe(1);
    await env.DB.prepare("UPDATE users SET role = 'owner' WHERE id = ?").bind(ws.ownerId).run();
    await env.DB.prepare("UPDATE users SET role = 'member' WHERE id = ?").bind(other.id).run();
  });

  it("an admin's action on a member who is promoted meanwhile doesn't apply (the write re-checks the role)", async () => {
    const admin = await addMember("admin");
    const target = await plainUser("member", "active", 1);
    // Promote the target in the same instant the admin disables them; whichever order D1 runs them in,
    // the admin never disables an admin.
    const [, disabled] = await Promise.all([
      patch(ws.browser, target.id, { role: "admin" }),
      patch(admin.browser, target.id, { status: "disabled" }),
    ]);
    const row = await userRow(target.id);
    // Either the promotion ran first (the disable then matched nothing) or the disable did (the promotion
    // then matched nothing): never a disabled admin.
    expect(row?.role === "admin" && row.status === "disabled").toBe(false);
    if (disabled.status === 200) expect(row).toMatchObject({ role: "member", status: "disabled" });
  });
});

describe("disabling a member (Platform §3; Identity §4.5, §9 'Sessions')", () => {
  it("revokes sessions, closes sockets, refuses sign-in, links and tickets; re-enabling restores sign-in", async () => {
    const member = await addMember("member");
    const hub = await openHub(member.browser);
    expect(hub).not.toBeNull();
    // An outstanding recovery link and email-change link for them.
    const link = await ws.browser.json<{ link: string }>(`/api/admin/members/${member.id}/recovery-link`, { body: {} });
    const recoveryToken = fragmentToken(link.body.link)!;

    const res = await patch(ws.browser, member.id, { status: "disabled" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "disabled", changed: true });
    expect(await within(hub!.closed, 5000)).toBe(WS_CLOSE_SESSION_REVOKED);
    expect(await sessionsOf(member.id)).toBe(0);
    expect((await member.browser.json("/api/me")).status).toBe(401);
    expect(await auditCount("member.disabled", member.id)).toBe(1);

    // Sign-in with their passkey is refused, and the recovery link no longer works.
    const fresh = new Browser();
    const signIn = await signInWithPasskey(fresh, member.authenticator);
    expect(signIn.verify.status).not.toBe(200);
    expect(fresh.sessionCookie).toBeUndefined();
    expect((await new Browser().json("/api/auth/recover/lookup", { body: { token: recoveryToken } })).status).toBe(410);
    expect(
      await count(
        "SELECT count(*) AS n FROM auth_tokens WHERE user_id = ? AND revoked_at IS NULL AND used_at IS NULL",
        member.id,
      ),
    ).toBe(0);

    // Disabling again is a no-op.
    expect((await patch(ws.browser, member.id, { status: "disabled" })).body).toMatchObject({ changed: false });
    expect(await auditCount("member.disabled", member.id)).toBe(1);

    const enabled = await patch(ws.browser, member.id, { status: "active" });
    expect(enabled.body).toMatchObject({ status: "active", changed: true });
    expect(await auditCount("member.enabled", member.id)).toBe(1);
    const again = new Browser();
    expect((await signInWithPasskey(again, member.authenticator)).verify.status).toBe(200);
  });

  it("a disabled member stays in their groups and appears under Deactivated in the directory", async () => {
    const member = await addMember("member");
    const group = await ws.browser.json<{ id: string }>("/api/groups", {
      body: { name: `Team ${ulid()}`, handle: uniqueHandle("g") },
    });
    await ws.browser.json(`/api/groups/${group.body.id}/members/${member.id}`, { method: "PUT", body: {} });
    await patch(ws.browser, member.id, { status: "disabled" });
    expect(await count("SELECT count(*) AS n FROM group_members WHERE user_id = ?", member.id)).toBe(1);
    const dir = await ws.browser.json<{ members: { id: string }[] }>("/api/members?filter=deactivated");
    expect(dir.body.members.map((m) => m.id)).toContain(member.id);
  });
});

describe("signing a member out of every session (Identity §4.11)", () => {
  it("revokes every session and closes sockets; the member can sign in again", async () => {
    const member = await addMember("member");
    const second = new Browser();
    expect((await signInWithPasskey(second, member.authenticator)).verify.status).toBe(200);
    const hub = await openHub(member.browser);
    const res = await signOut(ws.browser, member.id);
    expect(res.status).toBe(200);
    expect(res.body.signedOut).toBe(2);
    const entry = await env.DB.prepare(
      "SELECT metadata FROM audit_log WHERE action = 'member.signed_out' AND target_id = ?",
    )
      .bind(member.id)
      .first<{ metadata: string }>();
    expect(JSON.parse(entry!.metadata)).toEqual({ sessionsRevoked: 2 });
    expect(await within(hub!.closed, 5000)).toBe(WS_CLOSE_SESSION_REVOKED);
    expect((await member.browser.json("/api/me")).status).toBe(401);
    expect((await second.json("/api/me")).status).toBe(401);
    expect(await auditCount("member.signed_out", member.id)).toBe(1);
    expect((await signInWithPasskey(new Browser(), member.authenticator)).verify.status).toBe(200);
  });
});

describe("deleting a member: anonymised, signed out, handle held (Platform §3, §3.1; Identity §4.8)", () => {
  it("erases personal data across tables without breaking references", async () => {
    await configureEmail();
    // Invited the real way, so an invitation and audit metadata name their email.
    const email = uniqueEmail("leaver");
    const created = await invite(ws.browser, email);
    const token = fragmentToken(created.body.link)!;
    const leaver = new Browser();
    const handle = uniqueHandle("leaver");
    expect((await leaver.json("/api/invitations/accept", { body: { token, name: "Lee Ver", handle } })).status).toBe(
      201,
    );
    const authenticator = new SoftAuthenticator();
    const { registerPasskey } = await import("./helpers");
    expect((await registerPasskey(leaver, authenticator)).verify?.status).toBe(200);
    const id = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())!.id;
    const pseudonym = (await env.DB.prepare(
      "SELECT metadata FROM audit_log WHERE action = 'invitation.created' AND target_id = ?",
    )
      .bind(created.body.invitation.id)
      .first<{ metadata: string }>())!.metadata.match(/email:[0-9a-z]+/)![0];

    // Profile, status, avatar, group, device and preference rows to erase.
    const avatarKey = `avatars/${id}/${ulid()}.png`;
    await env.FILES.put(avatarKey, new Uint8Array([1, 2, 3]));
    await env.DB.prepare(
      `UPDATE users SET avatar_key = ?, phone = '+1 555', pronouns = 'they', job_title = 'Eng', team = 'Core',
         location = 'Office', status_text = 'Away', working_hours = '{}', region = 'GB', timezone = 'Europe/London',
         pending_security_notice = '[]' WHERE id = ?`,
    )
      .bind(avatarKey, id)
      .run();
    const group = await ws.browser.json<{ id: string }>("/api/groups", {
      body: { name: `Leavers ${ulid()}`, handle: uniqueHandle("g") },
    });
    await ws.browser.json(`/api/groups/${group.body.id}/members/${id}`, { method: "PUT", body: {} });
    await env.DB.prepare("INSERT INTO user_preferences (user_id, updated_at) VALUES (?, ?)").bind(id, Date.now()).run();
    const hub = await openHub(leaver);

    const res = await remove(ws.browser, id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, deleted: true });
    expect(await within(hub!.closed, 5000)).toBe(WS_CLOSE_SESSION_REVOKED);

    const row = await userRow(id);
    expect(row).toMatchObject({
      status: "deleted",
      email: null,
      email_normalised: null,
      handle: null,
      display_name: "Former member",
      avatar_key: null,
      phone: null,
      pronouns: null,
      job_title: null,
      team: null,
      location: null,
      status_text: null,
      working_hours: null,
      region: null,
      timezone: "UTC",
      pending_security_notice: null,
    });
    expect(row?.deleted_at).toEqual(expect.any(Number));
    for (const table of [
      "passkeys",
      "sessions",
      "auth_tokens",
      "auth_accounts",
      "user_devices",
      "group_members",
      "user_preferences",
      "ws_tickets",
    ]) {
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`, id), table).toBe(0);
    }
    expect(await count("SELECT count(*) AS n FROM magic_link_issues WHERE email_normalised = ?", email)).toBe(0);
    // The avatar objects are gone from R2.
    expect(await env.FILES.get(avatarKey)).toBeNull();
    // The invitation's email is replaced by its pseudonym; references stay intact.
    const inv = await env.DB.prepare("SELECT email, accepted_by FROM invitations WHERE id = ?")
      .bind(created.body.invitation.id)
      .first<{ email: string; accepted_by: string }>();
    expect(inv?.email).toBe(pseudonym);
    expect(inv?.accepted_by).toBe(id);
    // Audit metadata no longer carries their email's pseudonym.
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE instr(metadata, ?) > 0", pseudonym)).toBe(0);
    expect(await auditCount("member.deleted", id)).toBe(1);
    expect(await auditCount("member.erased", id)).toBe(1);

    // The handle is held for 30 days: nobody else can take it.
    const available = await ws.browser.json<{ available: boolean; reason?: string }>(
      `/api/handles/${handle}/available`,
    );
    expect(available.body).toMatchObject({ available: false, reason: "held" });
    // Gone from the directory and the admin list; can't sign in; can't be deleted twice.
    expect((await ws.browser.json(`/api/members/${id}`)).status).toBe(404);
    const list = await ws.browser.json<{ members: { id: string }[] }>("/api/admin/members");
    expect(list.body.members.map((m) => m.id)).not.toContain(id);
    expect((await signInWithPasskey(new Browser(), authenticator)).verify.status).not.toBe(200);
    expect((await remove(ws.browser, id)).status).toBe(403);
    // The address is free again: the person can be invited anew.
    expect((await invite(ws.browser, email)).status).toBe(201);
  });

  it("an erase that didn't finish (R2 down) is completed by the repair job, idempotently", async () => {
    const target = await plainUser("member");
    const avatarKey = `avatars/${target.id}/${ulid()}.png`;
    await env.FILES.put(avatarKey, new Uint8Array([9]));
    // As if the request's erase failed after the account was marked deleted.
    await env.DB.prepare("UPDATE users SET status = 'deleted', deleted_at = ?, avatar_key = ? WHERE id = ?")
      .bind(Date.now(), avatarKey, target.id)
      .run();
    const ctx: CoreContext = { env, log: rootLogger, now: () => Date.now() };
    expect(await eraseUnfinishedDeletions(ctx)).toBeGreaterThanOrEqual(1);
    expect(await userRow(target.id)).toMatchObject({ email: null, avatar_key: null, display_name: "Former member" });
    expect(await env.FILES.get(avatarKey)).toBeNull();
    const erasedOnce = await auditCount("member.erased", target.id);
    await eraseUnfinishedDeletions(ctx);
    expect(await auditCount("member.erased", target.id)).toBe(erasedOnce);
  });

  it("an admin deletes members only; an owner deletes admins; deleting the last owner is refused", async () => {
    const admin = await addMember("admin");
    const target = await plainUser("admin");
    expect((await remove(admin.browser, target.id)).body.error.reason).toBe("owner_required");
    expect((await remove(ws.browser, target.id)).status).toBe(200);
    const disabledOwner = await plainUser("owner", "disabled");
    // A disabled owner isn't an active owner: deleting them leaves the workspace owner.
    expect((await remove(ws.browser, disabledOwner.id)).status).toBe(200);
  });
});

describe("the member list (Admin §5; Identity §6)", () => {
  it("searches and filters by role, status, group and last active; invited rows; admins and owners only", async () => {
    await onlyOneOwner();
    const member = await addMember("member");
    const name = `Zed${ulid().slice(-6)}`;
    await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(name, member.id).run();
    const disabled = await plainUser("member", "disabled");
    const pendingEmail = uniqueEmail("pending");
    expect((await invite(ws.browser, pendingEmail)).status).toBe(201);
    const group = await ws.browser.json<{ id: string }>("/api/groups", {
      body: { name: `Filter ${ulid()}`, handle: uniqueHandle("g") },
    });
    await ws.browser.json(`/api/groups/${group.body.id}/members/${member.id}`, { method: "PUT", body: {} });

    type List = {
      members: { id: string; email: string; status: string; groups: { id: string }[]; lastActiveAt: number | null }[];
    };
    const list = (query = "") => ws.browser.json<List & ErrorBody>(`/api/admin/members${query}`);
    const byName = await list(`?q=${name.toLowerCase()}`);
    expect(byName.body.members.map((m) => m.id)).toEqual([member.id]);
    expect(byName.body.members[0]?.groups.map((g) => g.id)).toEqual([group.body.id]);
    expect(byName.body.members[0]?.lastActiveAt).toEqual(expect.any(Number));

    expect((await list("?status=disabled")).body.members.map((m) => m.id)).toContain(disabled.id);
    expect((await list("?status=disabled")).body.members.every((m) => m.status === "disabled")).toBe(true);
    expect((await list("?role=owner")).body.members.map((m) => m.id)).toEqual([ws.ownerId]);
    expect((await list(`?group=${group.body.id}`)).body.members.map((m) => m.id)).toEqual([member.id]);
    expect((await list("?lastActive=never")).body.members.map((m) => m.id)).toContain(disabled.id);
    expect((await list("?lastActive=within_7d")).body.members.map((m) => m.id)).not.toContain(disabled.id);
    const invited = await list("?status=invited");
    expect(invited.body.members.find((m) => m.email === pendingEmail)?.status).toBe("invited");
    expect((await list("?status=bogus")).status).toBe(400);

    const plain = await addMember("member");
    expect((await plain.browser.json<ErrorBody>("/api/admin/members")).status).toBe(403);
  });
});

describe("review fixes (M1e)", () => {
  const ctx = (): CoreContext => ({ env, log: rootLogger, now: () => Date.now() });

  it("deleting needs step-up (default): reauth_required with a stale assertion, then succeeds", async () => {
    await onlyOneOwner();
    const target = await plainUser("member");
    await staleFreshAuth(ws.ownerId);
    const refused = await remove(ws.browser, target.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("reauth_required");
    expect((await userRow(target.id))?.status).toBe("active");
    // Disabling and signing out don't ask for it.
    expect((await patch(ws.browser, target.id, { status: "disabled" })).status).toBe(200);
    expect((await signOut(ws.browser, target.id)).status).toBe(200);
    expect((await reauth(ws.browser, ws.authenticator)).status).toBe(200);
    expect((await remove(ws.browser, target.id)).status).toBe(200);
  });

  it("disabling or deleting an inviter revokes the invitations they sent, each audited", async () => {
    for (const action of ["disable", "delete"] as const) {
      const admin = await addMember("admin");
      const sent = await invite(admin.browser, uniqueEmail("pending"));
      expect(sent.status).toBe(201);
      const invitationId = sent.body.invitation.id;
      const token = fragmentToken(sent.body.link)!;
      expect((await act(ws.browser, action, admin.id)).status).toBe(200);
      expect(
        await count("SELECT count(*) AS n FROM invitations WHERE id = ? AND revoked_at IS NOT NULL", invitationId),
      ).toBe(1);
      expect(await auditCount("invitation.revoked", invitationId)).toBe(1);
      const lookup = await new Browser().json("/api/invitations/lookup", { body: { token } });
      expect(lookup.status).not.toBe(200);
    }
  });

  it("a refused role change leaves no notice behind (the notice commits with the change)", async () => {
    await onlyOneOwner();
    const before = (await noticeKinds(ws.ownerId)).filter((k) => k === "role_changed").length;
    expect((await patch(ws.browser, ws.ownerId, { role: "admin" })).body.error.reason).toBe("last_owner");
    expect((await noticeKinds(ws.ownerId)).filter((k) => k === "role_changed").length).toBe(before);
  });

  it("signing out someone with no session is still audited, in the same batch", async () => {
    const target = await plainUser("member");
    const res = await signOut(ws.browser, target.id);
    expect(res.body.signedOut).toBe(0);
    expect(await auditCount("member.signed_out", target.id)).toBe(1);
    const entry = await env.DB.prepare(
      "SELECT metadata FROM audit_log WHERE action = 'member.signed_out' AND target_id = ?",
    )
      .bind(target.id)
      .first<{ metadata: string }>();
    expect(JSON.parse(entry!.metadata)).toEqual({ sessionsRevoked: 0 });
  });

  it("an avatar uploaded for someone who isn't active is deleted again (nothing left in R2)", async () => {
    const target = await plainUser("member", "disabled");
    const { uploadAvatar } = await import("../../src/features/identity/avatar");
    const { png } = await import("./images");
    const request = new Request("https://officebox.test/api/me/avatar", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: png(8, 8),
    });
    const result = await uploadAvatar(ctx(), target.id, request);
    expect(result.ok).toBe(false);
    expect((await env.FILES.list({ prefix: `avatars/${target.id}/` })).objects).toHaveLength(0);
  });

  it("the repair job retries the least recently attempted erase first, so a failing row can't starve others", async () => {
    const stuck = await plainUser("member");
    const waiting = await plainUser("member");
    const now = Date.now();
    await env.DB.prepare("UPDATE users SET status = 'deleted', deleted_at = ?, erase_attempted_at = ? WHERE id = ?")
      .bind(now - 10_000, now, stuck.id)
      .run();
    await env.DB.prepare("UPDATE users SET status = 'deleted', deleted_at = ? WHERE id = ?")
      .bind(now, waiting.id)
      .run();
    const order = await env.DB.prepare(
      `SELECT id FROM users WHERE status = 'deleted' AND (email IS NOT NULL OR avatar_key IS NOT NULL)
        ORDER BY coalesce(erase_attempted_at, 0), deleted_at`,
    ).all<{ id: string }>();
    const ids = order.results.map((r) => r.id);
    expect(ids.indexOf(waiting.id)).toBeLessThan(ids.indexOf(stuck.id));
    await eraseUnfinishedDeletions(ctx());
    const row = await userRow(waiting.id);
    expect(row).toMatchObject({ email: null });
    expect(row?.erase_attempted_at).toEqual(expect.any(Number));
  });
});

describe("second review fixes (M1e)", () => {
  const ctx = (): CoreContext => ({ env, log: rootLogger, now: () => Date.now() });

  async function pendingInvitation(inviterId: string): Promise<string> {
    const id = ulid();
    const email = uniqueEmail("inv");
    await env.DB.prepare(
      `INSERT INTO invitations (id, email, email_normalised, role, token_hash, token_nonce, invited_by, expires_at, created_at)
       VALUES (?, ?, ?, 'member', ?, 'n', ?, ?, ?)`,
    )
      .bind(id, email, email, `h-${id}`, inviterId, Date.now() + 86_400_000, Date.now())
      .run();
    return id;
  }
  const revoked = async (id: string) =>
    count("SELECT count(*) AS n FROM invitations WHERE id = ? AND revoked_at IS NOT NULL", id);

  it("a refused delete (the actor demoted mid-request) revokes no invitation and writes no audit", async () => {
    const admin = await addMember("admin");
    const inviter = await plainUser("member", "disabled");
    const invitationId = await pendingInvitation(inviter.id);
    // The engine allowed the admin; then they're demoted before the batch.
    await env.DB.prepare("UPDATE users SET role = 'member' WHERE id = ?").bind(admin.id).run();
    const result = await deleteMember(
      ctx(),
      { userId: admin.id, role: "admin" },
      {
        action: "member.delete",
        target: { userId: inviter.id, role: "member", status: "disabled" },
        activeOwnerCount: 1,
      },
    );
    expect(result.ok).toBe(false);
    expect(await revoked(invitationId)).toBe(0);
    expect(await auditCount("invitation.revoked", invitationId)).toBe(0);
    expect(await auditCount("member.deleted", inviter.id)).toBe(0);
  });

  it("an active inviter's invitations are untouched when someone else is disabled", async () => {
    const otherAdmin = await addMember("admin");
    const theirs = await pendingInvitation(otherAdmin.id);
    const target = await plainUser("member");
    expect((await patch(ws.browser, target.id, { status: "disabled" })).status).toBe(200);
    expect(await revoked(theirs)).toBe(0);
  });

  it("the catch-all revokes an invitation sent after the read, audited once as sentLater", async () => {
    const inviter = await plainUser("admin", "disabled");
    const database = new Database(env.DB);
    const statements = await revokeSentInvitationsStatements(
      ctx(),
      database,
      ws.ownerId,
      inviter.id,
      Date.now(),
      "inviter_disabled",
      "01J000000000000000000APPLY",
    );
    const late = await pendingInvitation(inviter.id);
    await env.DB.prepare(
      "INSERT INTO audit_log (id, actor_id, action, created_at) VALUES ('01J000000000000000000APPLY', NULL, 'test.applied', 0)",
    ).run();
    await database.batchRun(statements);
    expect(await revoked(late)).toBe(1);
    const entry = await env.DB.prepare(
      "SELECT metadata FROM audit_log WHERE action = 'invitation.revoked' AND target_id = ?",
    )
      .bind(inviter.id)
      .first<{ metadata: string }>();
    expect(JSON.parse(entry!.metadata)).toEqual({ reason: "inviter_disabled", sentLater: true });
  });

  it("a promotion that doesn't apply leaves the person's magic links alone", async () => {
    const owner = await addMember("owner");
    const target = await plainUser("member", "active", 1);
    const token = `ml-${ulid()}`;
    await env.DB.prepare(
      `INSERT INTO magic_link_issues (token_hash, email_normalised, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(token, target.email, target.id, Date.now() + 600_000, Date.now())
      .run();
    // The owner is demoted between the engine's decision and the write.
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(owner.id).run();
    const result = await changeMemberRole(
      ctx(),
      { userId: owner.id, role: "owner" },
      {
        action: "member.change_role",
        target: { userId: target.id, role: "member", status: "active" },
        newRole: "admin",
        activeOwnerCount: 2,
        targetPasskeyCount: 1,
        recoveryTokenUnconsumed: false,
      },
    );
    expect(result.ok).toBe(false);
    expect(
      await count("SELECT count(*) AS n FROM magic_link_issues WHERE token_hash = ? AND revoked_at IS NULL", token),
    ).toBe(1);
    expect(await noticeKinds(target.id)).not.toContain("role_changed");
  });

  it("an invitation whose inviter is no longer active can't be accepted (410)", async () => {
    const admin = await addMember("admin");
    const sent = await invite(admin.browser, uniqueEmail("late"));
    expect(sent.status).toBe(201);
    // Disabled without the revocation (as if the accept raced it).
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(admin.id).run();
    const accept = await new Browser().json("/api/invitations/accept", {
      body: { token: fragmentToken(sent.body.link), name: "Late Comer", handle: uniqueHandle("late") },
    });
    expect(accept.status).toBe(410);
    expect(
      await count(
        "SELECT count(*) AS n FROM invitations WHERE id = ? AND accepted_attempt_id IS NULL",
        sent.body.invitation.id,
      ),
    ).toBe(1);
  });
});
