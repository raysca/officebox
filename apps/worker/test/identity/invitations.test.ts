import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ulid } from "../../src/core/ids";
import { repairInvitations, REPAIR_GRACE_MS } from "../../src/features/identity/invitations";
import { rootLogger } from "../../src/core/log";
import { SoftAuthenticator } from "./authenticator";
import {
  acceptInvite,
  addMember,
  Browser,
  configureEmail,
  fragmentToken,
  invite,
  meetInviteGate,
  ORIGIN,
  outbox,
  registerPasskey,
  setSetting,
  setupWorkspace,
  signInWithPasskey,
  uniqueEmail,
  uniqueHandle,
  type Workspace,
} from "./helpers";

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
  await meetInviteGate(ws);
});

const count = async (sql: string, ...params: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;

describe("creating invitations (Identity §4.2; Permissions §4.6)", () => {
  it("an owner invites a member by copy link: the link is on the canonical origin with the token only in the fragment", async () => {
    const email = uniqueEmail("inv");
    const created = await invite(ws.browser, email);
    expect(created.status).toBe(201);
    expect(created.body.email).toBe("not_requested");
    expect(created.body.invitation).toMatchObject({ email, role: "member", status: "pending" });
    const url = new URL(created.body.link);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/invitations/accept");
    expect(url.search).toBe("");
    expect(fragmentToken(created.body.link)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the hash is stored.
    const stored = await env.DB.prepare("SELECT token_hash FROM invitations WHERE id = ?")
      .bind(created.body.invitation.id)
      .first<{ token_hash: string }>();
    expect(stored!.token_hash).not.toBe(fragmentToken(created.body.link));
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'invitation.created' AND target_id = ?",
        created.body.invitation.id,
      ),
    ).toBe(1);
  });

  it("with email not configured, asking for email still gives a working copy link", async () => {
    const created = await invite(ws.browser, uniqueEmail("noemail"), "member", true);
    expect(created.status).toBe(201);
    expect(created.body.email).toBe("not_configured");
    expect(fragmentToken(created.body.link)).not.toBeNull();
  });

  it("members can't invite; admins invite members but not admins; owners invite admins", async () => {
    const member = await addMember("member");
    expect((await invite(member.browser, uniqueEmail())).body).toMatchObject({
      error: { code: "forbidden", reason: "not_permitted" },
    });
    const admin = await addMember("admin");
    expect((await invite(admin.browser, uniqueEmail())).status).toBe(201);
    expect((await invite(admin.browser, uniqueEmail(), "admin")).body).toMatchObject({
      error: { code: "forbidden", reason: "owner_required" },
    });
    expect((await invite(ws.browser, uniqueEmail(), "admin")).status).toBe(201);
    // Owner is never an invitable role.
    const owner = await ws.browser.json("/api/admin/invitations", {
      body: { email: uniqueEmail(), role: "owner", sendEmail: false },
    });
    expect(owner.status).toBe(400);
  });

  it("a second pending invitation for the same normalised email is refused", async () => {
    const email = uniqueEmail("dup");
    expect((await invite(ws.browser, email)).status).toBe(201);
    const again = await invite(ws.browser, `  ${email.toUpperCase()}  `);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { reason: "invitation_pending" } });
  });

  it("an expired pending invitation is replaced by a new one", async () => {
    const email = uniqueEmail("exp");
    const first = await invite(ws.browser, email);
    await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, first.body.invitation.id)
      .run();
    const second = await invite(ws.browser, email);
    expect(second.status).toBe(201);
    const revoked = await env.DB.prepare("SELECT revoked_at FROM invitations WHERE id = ?")
      .bind(first.body.invitation.id)
      .first<{ revoked_at: number | null }>();
    expect(revoked!.revoked_at).not.toBeNull();
  });

  it("an active member's email is refused; a disabled member's is offered re-enable", async () => {
    const member = await addMember();
    expect((await invite(ws.browser, member.email)).body).toMatchObject({ error: { reason: "already_member" } });
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    expect((await invite(ws.browser, member.email)).body).toMatchObject({ error: { reason: "member_disabled" } });
  });

  it("the allowed email domains setting restricts who can be invited (default off)", async () => {
    await setSetting("allowed_invite_domains", ["allowed.test"]);
    try {
      const refused = await invite(ws.browser, uniqueEmail("dom"));
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ error: { reason: "invite_domain_not_allowed" } });
      expect((await invite(ws.browser, `p-${ulid().toLowerCase()}@Allowed.test`)).status).toBe(201);
    } finally {
      await setSetting("allowed_invite_domains", []);
    }
  });
});

describe("the owners' invite gate (Identity §2; PLAN M1 exit criteria)", () => {
  it("an owner with one passkey and no unconsumed RECOVERY_TOKEN is refused; a second passkey or the secret lets them invite", async () => {
    const solo = await setupWorkspace();
    const refused = await invite(solo.browser, uniqueEmail());
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { reason: "owner_invite_gate" } });
    // Admin invitations too.
    expect((await invite(solo.browser, uniqueEmail(), "admin")).body).toMatchObject({
      error: { reason: "owner_invite_gate" },
    });

    // With RECOVERY_TOKEN set (and unconsumed), the owner can invite.
    const recovery = "recovery-token-0123456789abcdefghijklmnopqrstuv";
    const withSecret = await solo.browser.json("/api/admin/invitations", {
      body: { email: uniqueEmail(), role: "member", sendEmail: false },
      env: { RECOVERY_TOKEN: recovery },
    });
    expect(withSecret.status).toBe(201);

    // A consumed secret no longer satisfies it.
    const { tokenHash } = await import("../../src/features/identity/crypto");
    await env.DB.prepare("INSERT INTO recovery_token_uses (token_hash, owner_id, used_at) VALUES (?, ?, ?)")
      .bind(await tokenHash(env.TOKEN_HASH_KEY!, recovery), solo.ownerId, Date.now())
      .run();
    const consumed = await solo.browser.json("/api/admin/invitations", {
      body: { email: uniqueEmail(), role: "member", sendEmail: false },
      env: { RECOVERY_TOKEN: recovery },
    });
    expect(consumed.body).toMatchObject({ error: { reason: "owner_invite_gate" } });

    // An admin can still invite members.
    const admin = await addMember("admin");
    expect((await invite(admin.browser, uniqueEmail())).status).toBe(201);

    // A second passkey lets the owner invite.
    await registerPasskey(solo.browser, new SoftAuthenticator());
    expect((await invite(solo.browser, uniqueEmail())).status).toBe(201);
    ws = solo;
  });
});

describe("managing invitations: list, copy again, resend, revoke (Identity §4.2)", () => {
  it("lists pending invitations with inviter, sent, expiry and status", async () => {
    const email = uniqueEmail("list");
    const created = await invite(ws.browser, email);
    const list = await ws.browser.json<{
      invitations: { id: string; email: string; invitedBy: unknown; status: string }[];
    }>("/api/admin/invitations");
    expect(list.status).toBe(200);
    const row = list.body.invitations.find((i) => i.id === created.body.invitation.id);
    expect(row).toMatchObject({ email, status: "pending", invitedBy: { id: ws.ownerId, displayName: "Sam Lee" } });
    const member = await addMember();
    expect((await member.browser.json("/api/admin/invitations")).status).toBe(403);
  });

  it("copy again returns the same link while the invitation is valid", async () => {
    const created = await invite(ws.browser, uniqueEmail("copy"));
    const copied = await ws.browser.json<{ link: string }>(`/api/admin/invitations/${created.body.invitation.id}/link`);
    expect(copied.status).toBe(200);
    expect(copied.body.link).toBe(created.body.link);
    await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, created.body.invitation.id)
      .run();
    expect((await ws.browser.json(`/api/admin/invitations/${created.body.invitation.id}/link`)).status).toBe(410);
  });

  it("resend emails the same link when email is configured, and is audited", async () => {
    const email = uniqueEmail("resend");
    const created = await invite(ws.browser, email);
    expect(
      (await ws.browser.json(`/api/admin/invitations/${created.body.invitation.id}/resend`, { body: {} })).body,
    ).toEqual({
      email: "not_configured",
    });
    await configureEmail();
    try {
      const resent = await ws.browser.json(`/api/admin/invitations/${created.body.invitation.id}/resend`, { body: {} });
      expect(resent.body).toEqual({ email: "queued" });
      const [message] = outbox.to(email);
      expect(message).toBeDefined();
      expect(message!.kind).toBe("invitation");
      expect(message!.text).toContain(created.body.link);
      expect(message!.html).toContain(created.body.link);
      expect(message!.subject).toBe("You're invited to Acme Studio");
      expect(
        await count(
          "SELECT count(*) AS n FROM audit_log WHERE action = 'invitation.resent' AND target_id = ?",
          created.body.invitation.id,
        ),
      ).toBe(2);
    } finally {
      await configureEmail({ driver: "none" });
    }
  });

  it("an invitation by email: the email carries the copy link", async () => {
    await configureEmail();
    try {
      const email = uniqueEmail("byemail");
      const created = await invite(ws.browser, email, "member", true);
      expect(created.body.email).toBe("queued");
      const [message] = outbox.to(email);
      expect(fragmentToken(message!.text)).toBe(fragmentToken(created.body.link));
      // The delivery job is recorded without the address or content.
      const row = await env.DB.prepare("SELECT kind, state, recipient_hash FROM email_deliveries WHERE id = ?")
        .bind(message!.jobId)
        .first<{ kind: string; state: string; recipient_hash: string }>();
      expect(row).toMatchObject({ kind: "invitation", state: "queued" });
      expect(row!.recipient_hash).not.toContain("@");
    } finally {
      await configureEmail({ driver: "none" });
    }
  });

  it("revoke: admins revoke member invitations, owners revoke admin ones; a revoked link is refused", async () => {
    const created = await invite(ws.browser, uniqueEmail("rev"));
    const adminInvite = await invite(ws.browser, uniqueEmail("revadmin"), "admin");
    const admin = await addMember("admin");
    expect(
      (
        await admin.browser.json(`/api/admin/invitations/${adminInvite.body.invitation.id}`, {
          method: "DELETE",
          body: {},
        })
      ).body,
    ).toMatchObject({
      error: { reason: "owner_required" },
    });
    const revoked = await admin.browser.json(`/api/admin/invitations/${created.body.invitation.id}`, {
      method: "DELETE",
      body: {},
    });
    expect(revoked.status).toBe(200);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'invitation.revoked' AND target_id = ?",
        created.body.invitation.id,
      ),
    ).toBe(1);
    const lookup = await new Browser().json("/api/invitations/lookup", {
      body: { token: fragmentToken(created.body.link) },
    });
    expect(lookup.status).toBe(410);
    // Revoking again: not found.
    expect(
      (await ws.browser.json(`/api/admin/invitations/${created.body.invitation.id}`, { method: "DELETE", body: {} }))
        .status,
    ).toBe(404);
  });

  it("members get 403 on every management route, whether or not the invitation exists", async () => {
    const created = await invite(ws.browser, uniqueEmail("m403"));
    const member = await addMember();
    for (const id of [created.body.invitation.id, ulid()]) {
      expect((await member.browser.json(`/api/admin/invitations/${id}/link`)).status).toBe(403);
      expect((await member.browser.json(`/api/admin/invitations/${id}/resend`, { body: {} })).status).toBe(403);
      expect((await member.browser.json(`/api/admin/invitations/${id}`, { method: "DELETE", body: {} })).status).toBe(
        403,
      );
    }
  });
});

describe("accepting an invitation (Identity §4.3)", () => {
  it("shows the invited email, creates the account, registers a passkey with the ticket and signs in", async () => {
    const email = uniqueEmail("acc");
    const created = await invite(ws.browser, email);
    const token = fragmentToken(created.body.link)!;
    const lookup = await new Browser().json("/api/invitations/lookup", { body: { token } });
    expect(lookup.body).toEqual({ email, role: "member", workspaceName: "Acme Studio", state: "new" });

    const { browser, accept, handle } = await acceptInvite(token, "Ana Diaz");
    expect(accept.status).toBe(201);
    expect(accept.body).toMatchObject({ email, resumed: false });
    // The ticket is an HttpOnly cookie, never in the body.
    expect(JSON.stringify(accept.body)).not.toMatch(/ticket|token/i);
    expect(browser.cookies.get("__Host-officebox-enrol")).toBeDefined();
    const user = await env.DB.prepare(
      "SELECT id, role, handle, display_name, created_attempt_id FROM users WHERE email = ?",
    )
      .bind(email)
      .first<{ id: string; role: string; handle: string; display_name: string; created_attempt_id: string }>();
    expect(user).toMatchObject({ role: "member", handle, display_name: "Ana Diaz" });
    const inv = await env.DB.prepare(
      "SELECT accepted_attempt_id, accepted_by, accepted_at FROM invitations WHERE id = ?",
    )
      .bind(created.body.invitation.id)
      .first<{ accepted_attempt_id: string; accepted_by: string; accepted_at: number }>();
    expect(inv!.accepted_attempt_id).toBe(user!.created_attempt_id);
    expect(inv!.accepted_by).toBe(user!.id);
    const handleRow = await env.DB.prepare("SELECT owner_id, created_attempt_id FROM handles WHERE handle = ?")
      .bind(handle)
      .first<{ owner_id: string; created_attempt_id: string }>();
    expect(handleRow).toEqual({ owner_id: user!.id, created_attempt_id: user!.created_attempt_id });

    const reg = await registerPasskey(browser, new SoftAuthenticator());
    expect(reg.verify?.status).toBe(200);
    expect(browser.sessionCookie).toBeDefined();
    const me = await browser.json<{ user: { email: string } }>("/api/me");
    expect(me.body.user.email).toBe(email);
    const passkey = await env.DB.prepare("SELECT created_via FROM passkeys WHERE user_id = ?")
      .bind(user!.id)
      .first<{ created_via: string }>();
    expect(passkey!.created_via).toBe("invitation");
    // The first passkey at acceptance raises no security notice.
    const notices = await env.DB.prepare("SELECT pending_security_notice AS p FROM users WHERE id = ?")
      .bind(user!.id)
      .first<{ p: string | null }>();
    expect(notices!.p).toBeNull();
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'invitation.accepted' AND target_id = ?",
        created.body.invitation.id,
      ),
    ).toBe(1);
  });

  it("an admin invitation creates an admin", async () => {
    const email = uniqueEmail("accadmin");
    const created = await invite(ws.browser, email, "admin");
    const { accept } = await acceptInvite(fragmentToken(created.body.link)!);
    expect(accept.status).toBe(201);
    expect(
      (await env.DB.prepare("SELECT role FROM users WHERE email = ?").bind(email).first<{ role: string }>())!.role,
    ).toBe("admin");
  });

  it("expired, revoked, used and unknown invitations are refused", async () => {
    const expired = await invite(ws.browser, uniqueEmail("x1"));
    await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expired.body.invitation.id)
      .run();
    const expiredAccept = await acceptInvite(fragmentToken(expired.body.link)!);
    expect(expiredAccept.accept.status).toBe(410);
    expect(expiredAccept.accept.body).toMatchObject({ error: { reason: "invitation_expired" } });

    const unknown = await acceptInvite("A".repeat(43));
    expect(unknown.accept.status).toBe(410);

    const used = await invite(ws.browser, uniqueEmail("x2"));
    const first = await acceptInvite(fragmentToken(used.body.link)!);
    await registerPasskey(first.browser, new SoftAuthenticator());
    const second = await acceptInvite(fragmentToken(used.body.link)!);
    expect(second.accept.status).toBe(410);
  });

  it("a handle that's taken is refused before the invitation is consumed", async () => {
    const created = await invite(ws.browser, uniqueEmail("h"));
    const taken = await acceptInvite(fragmentToken(created.body.link)!, "Ana", ws.owner.handle);
    expect(taken.accept.status).toBe(409);
    expect(taken.accept.body).toMatchObject({ error: { reason: "handle_taken" } });
    const inv = await env.DB.prepare("SELECT accepted_attempt_id FROM invitations WHERE id = ?")
      .bind(created.body.invitation.id)
      .first<{ accepted_attempt_id: string | null }>();
    expect(inv!.accepted_attempt_id).toBeNull();
    expect((await acceptInvite(fragmentToken(created.body.link)!)).accept.status).toBe(201);
  });

  it("validates the name and handle", async () => {
    const created = await invite(ws.browser, uniqueEmail("v"));
    const bad = await new Browser().json("/api/invitations/accept", {
      body: { token: fragmentToken(created.body.link), name: "", handle: "admin" },
    });
    expect(bad.status).toBe(400);
  });

  it("a GET of the link page changes nothing (the token is only used by the page's POST)", async () => {
    const created = await invite(ws.browser, uniqueEmail("get"));
    const page = await new Browser().call(`/invitations/accept`, { noCsrf: true });
    expect(page.status).toBeLessThan(500);
    const inv = await env.DB.prepare("SELECT accepted_attempt_id FROM invitations WHERE id = ?")
      .bind(created.body.invitation.id)
      .first<{ accepted_attempt_id: string | null }>();
    expect(inv!.accepted_attempt_id).toBeNull();
  });

  it("CSRF: accept and lookup need the header and the canonical Origin", async () => {
    const created = await invite(ws.browser, uniqueEmail("csrf"));
    const token = fragmentToken(created.body.link);
    const missing = await new Browser().json("/api/invitations/accept", {
      body: { token, name: "A", handle: uniqueHandle() },
      noCsrf: true,
      headers: { origin: ORIGIN },
    });
    expect(missing.body).toMatchObject({ error: { code: "csrf_failed" } });
    const evil = await new Browser().json("/api/invitations/lookup", { body: { token }, origin: "https://evil.test" });
    expect(evil.body).toMatchObject({ error: { code: "csrf_failed" } });
  });

  it("lookup and accept are rate-limited per IP (5 per minute)", async () => {
    const browser = new Browser();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await browser.json("/api/invitations/lookup", { body: { token: "B".repeat(43) } })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 410)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

describe("reopening an accepted invitation (Identity §4.3: the 410 guard)", () => {
  it("reopens while the account has no passkey and no session; answers 410 once it has a passkey", async () => {
    const email = uniqueEmail("reo");
    const created = await invite(ws.browser, email);
    const token = fragmentToken(created.body.link)!;
    const first = await acceptInvite(token);
    expect(first.accept.status).toBe(201);
    const users = await count("SELECT count(*) AS n FROM users WHERE email = ?", email);

    const lookup = await new Browser().json("/api/invitations/lookup", { body: { token } });
    expect(lookup.body).toMatchObject({ email, state: "resume" });
    const again = await acceptInvite(token, "Someone Else", uniqueHandle("other"));
    expect(again.accept.status).toBe(201);
    expect(again.accept.body).toMatchObject({ email, resumed: true });
    // Same account, name and handle unchanged.
    expect(await count("SELECT count(*) AS n FROM users WHERE email = ?", email)).toBe(users);
    expect(
      (await env.DB.prepare("SELECT display_name FROM users WHERE email = ?")
        .bind(email)
        .first<{ display_name: string }>())!.display_name,
    ).toBe("Ana Diaz");

    // The earlier ticket was replaced; the reopened one registers the passkey.
    const reg = await registerPasskey(again.browser, new SoftAuthenticator());
    expect(reg.verify?.status).toBe(200);
    expect((await acceptInvite(token)).accept.status).toBe(410);
    expect((await new Browser().json("/api/invitations/lookup", { body: { token } })).status).toBe(410);
  });

  it("answers 410 once the account has had a session, even without a passkey", async () => {
    const email = uniqueEmail("reos");
    const created = await invite(ws.browser, email);
    const token = fragmentToken(created.body.link)!;
    await acceptInvite(token);
    await env.DB.prepare("UPDATE users SET first_signed_in_at = ? WHERE email = ?").bind(Date.now(), email).run();
    expect((await acceptInvite(token)).accept.status).toBe(410);
  });

  it("answers 410 once the invitation has expired, even with no passkey", async () => {
    const created = await invite(ws.browser, uniqueEmail("reoe"));
    const token = fragmentToken(created.body.link)!;
    await acceptInvite(token);
    await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, created.body.invitation.id)
      .run();
    expect((await acceptInvite(token)).accept.status).toBe(410);
  });
});

describe("concurrency (PLAN M1 exit criteria: concurrent tokens)", () => {
  it("two concurrent accepts of one invitation create exactly one account", async () => {
    const email = uniqueEmail("race");
    const created = await invite(ws.browser, email);
    const token = fragmentToken(created.body.link)!;
    const results = await Promise.all([
      acceptInvite(token, "A One", uniqueHandle("a")),
      acceptInvite(token, "B Two", uniqueHandle("b")),
    ]);
    const statuses = results.map((r) => r.accept.status);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    for (const s of statuses) expect([201, 409, 410]).toContain(s);
    expect(results.filter((r) => r.accept.status === 201 && !r.accept.body.resumed)).toHaveLength(1);
    expect(await count("SELECT count(*) AS n FROM users WHERE email = ?", email)).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM handles WHERE owner_id = (SELECT id FROM users WHERE email = ?)", email),
    ).toBe(1);
  });
});

describe("the repair job's invitation half (Identity §4.3; TDD §8.1 'never resurrect')", () => {
  const ctx = () => ({ env, log: rootLogger, now: Date.now });

  async function consumed(attemptAgoMs: number) {
    const created = await invite(ws.browser, uniqueEmail("rep"));
    const attempt = (await import("../../src/core/ids")).createUlidGenerator({
      now: () => Date.now() - attemptAgoMs,
    })();
    await env.DB.prepare("UPDATE invitations SET accepted_attempt_id = ? WHERE id = ?")
      .bind(attempt, created.body.invitation.id)
      .run();
    return { id: created.body.invitation.id, attempt, email: created.body.invitation.email };
  }
  const state = (id: string) =>
    env.DB.prepare("SELECT accepted_attempt_id, accepted_at, accepted_by FROM invitations WHERE id = ?")
      .bind(id)
      .first<{ accepted_attempt_id: string | null; accepted_at: number | null; accepted_by: string | null }>();

  it("releases a consumed invitation with nothing written, only after 10 minutes", async () => {
    const recent = await consumed(REPAIR_GRACE_MS - 60_000);
    const old = await consumed(REPAIR_GRACE_MS + 60_000);
    await repairInvitations(ctx());
    expect((await state(recent.id))!.accepted_attempt_id).toBe(recent.attempt);
    expect((await state(old.id))!.accepted_attempt_id).toBeNull();
    expect(
      await count("SELECT count(*) AS n FROM audit_log WHERE action = 'invitation.repaired' AND target_id = ?", old.id),
    ).toBe(1);
    // Released: it works again.
    const lookup = await invite(ws.browser, old.email);
    expect(lookup.status).toBe(409); // still pending, so a second invitation is refused
  });

  it("never releases an expired or revoked one", async () => {
    const expired = await consumed(REPAIR_GRACE_MS + 60_000);
    await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expired.id)
      .run();
    const revoked = await consumed(REPAIR_GRACE_MS + 60_000);
    await env.DB.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ?").bind(Date.now(), revoked.id).run();
    await repairInvitations(ctx());
    expect((await state(expired.id))!.accepted_attempt_id).toBe(expired.attempt);
    expect((await state(revoked.id))!.accepted_attempt_id).toBe(revoked.attempt);
  });

  it("never releases one whose attempt ID is on a handle", async () => {
    const withHandle = await consumed(REPAIR_GRACE_MS + 60_000);
    await env.DB.prepare(
      "INSERT INTO handles (handle, owner_type, owner_id, created_attempt_id) VALUES (?, 'user', NULL, ?)",
    )
      .bind(uniqueHandle("orphan"), withHandle.attempt)
      .run();
    await repairInvitations(ctx());
    expect((await state(withHandle.id))!.accepted_attempt_id).toBe(withHandle.attempt);
  });

  it("rolls forward when a user carries the attempt ID: the handle and accepted_by are finished", async () => {
    const partial = await consumed(REPAIR_GRACE_MS + 60_000);
    const userId = ulid();
    const handle = uniqueHandle("rf");
    await env.DB.prepare(
      `INSERT INTO users (id, email, email_normalised, display_name, role, status, handle, created_attempt_id, created_at, updated_at)
       VALUES (?, ?, ?, 'Rolled', 'member', 'active', ?, ?, ?, ?)`,
    )
      .bind(userId, partial.email, partial.email, handle, partial.attempt, Date.now(), Date.now())
      .run();
    await repairInvitations(ctx());
    expect(await state(partial.id)).toMatchObject({ accepted_attempt_id: partial.attempt, accepted_by: userId });
    expect((await state(partial.id))!.accepted_at).not.toBeNull();
    expect(
      (await env.DB.prepare("SELECT owner_id FROM handles WHERE handle = ?")
        .bind(handle)
        .first<{ owner_id: string }>())!.owner_id,
    ).toBe(userId);
  });

  it("a consumed invitation whose user was later deleted is rolled forward, never released", async () => {
    const partial = await consumed(REPAIR_GRACE_MS + 60_000);
    const userId = ulid();
    await env.DB.prepare(
      `INSERT INTO users (id, email, email_normalised, display_name, role, status, created_attempt_id, created_at, updated_at, deleted_at)
       VALUES (?, NULL, NULL, 'Former member', 'member', 'deleted', ?, ?, ?, ?)`,
    )
      .bind(userId, partial.attempt, Date.now(), Date.now(), Date.now())
      .run();
    await repairInvitations(ctx());
    expect(await state(partial.id)).toMatchObject({ accepted_attempt_id: partial.attempt, accepted_by: userId });
  });

  it("is idempotent", async () => {
    const old = await consumed(REPAIR_GRACE_MS + 60_000);
    await repairInvitations(ctx());
    const before = await count("SELECT count(*) AS n FROM audit_log WHERE action = 'invitation.repaired'");
    await repairInvitations(ctx());
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'invitation.repaired'")).toBe(before);
    expect((await state(old.id))!.accepted_attempt_id).toBeNull();
  });
});

describe("an invited member signs in with a passkey afterwards", () => {
  it("works end to end", async () => {
    const created = await invite(ws.browser, uniqueEmail("later"));
    const { browser } = await acceptInvite(fragmentToken(created.body.link)!);
    const authenticator = new SoftAuthenticator();
    await registerPasskey(browser, authenticator);
    const fresh = new Browser();
    const { verify } = await signInWithPasskey(fresh, authenticator);
    expect(verify.status).toBe(200);
    expect(fresh.sessionCookie).toBeDefined();
  });
});
