import { env } from "cloudflare:workers";
import { WS_CLOSE_SESSION_REVOKED } from "@officebox/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { onRevocation, type RevocationScope } from "../../src/features/identity/revocation";
import { SoftAuthenticator } from "./authenticator";
import {
  addMember,
  Browser,
  configureEmail,
  fragmentToken,
  ORIGIN,
  outbox,
  reauth,
  setSetting,
  setupWorkspace,
  signInWithPasskey,
  staleFreshAuth,
  uniqueEmail,
  type Workspace,
} from "./helpers";
import { auditCount, count, disableEmail, noticeKinds, openHub, registerAt, sessionsOf, within } from "./m1c-helpers";

/**
 * M1c recovery (Identity §4.6, §9 "Recovery link flow", "Owner recovery", "Admin powers",
 * "Notifications of admin actions"; Permissions §6, §11; Platform §8, §10).
 */

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
});
beforeEach(async () => {
  await configureEmail();
});

interface LinkBody {
  link: string;
  expiresAt: number;
  notifiedByEmail: boolean;
  flagged: boolean;
}
interface ErrorBody {
  error: { code: string; reason?: string };
}

function issue(browser: Browser, targetId: string) {
  return browser.json<LinkBody & ErrorBody>(`/api/admin/members/${targetId}/recovery-link`, { body: {} });
}

async function issuedToken(browser: Browser, targetId: string): Promise<string> {
  const res = await issue(browser, targetId);
  if (res.status !== 201) throw new Error(`issue failed: ${JSON.stringify(res.body)}`);
  return fragmentToken(res.body.link)!;
}

describe("issuing a recovery link: who may, for whom (Permissions §6, matrix)", () => {
  it("a member can't; an admin can for members only; an owner can for admins and owners", async () => {
    const member = await addMember("member");
    const other = await addMember("member");
    const admin = await addMember("admin");
    const owner2 = await addMember("owner");

    const byMember = await issue(member.browser, other.id);
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.reason).toBe("not_permitted");

    expect((await issue(admin.browser, member.id)).status).toBe(201);
    for (const target of [owner2.id, ws.ownerId]) {
      const refused = await issue(admin.browser, target);
      expect(refused.status).toBe(403);
      expect(refused.body.error.reason).toBe("owner_required");
    }
    const adminTwo = await addMember("admin");
    expect((await issue(admin.browser, adminTwo.id)).body.error.reason).toBe("owner_required");

    expect((await issue(ws.browser, admin.id)).status).toBe(201);
    expect((await issue(ws.browser, owner2.id)).status).toBe(201);
    expect((await issue(owner2.browser, ws.ownerId)).status).toBe(201);
    // Each issue is audited.
    expect(await auditCount("member.recovery_link_issued", owner2.id)).toBe(1);
  });

  it("a member asking about an unknown ID is refused without learning whether it exists", async () => {
    const member = await addMember();
    const res = await issue(member.browser, "01HZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(res.status).toBe(403);
    expect((await issue(ws.browser, "01HZZZZZZZZZZZZZZZZZZZZZZZ")).status).toBe(404);
    expect((await issue(ws.browser, "not-an-id")).status).toBe(404);
  });

  it("needs step-up: reauth_required without a fresh passkey assertion, then succeeds after one", async () => {
    const admin = await addMember("admin");
    const member = await addMember();
    await staleFreshAuth(admin.id);
    const refused = await issue(admin.browser, member.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("reauth_required");
    expect(
      await count("SELECT count(*) AS n FROM auth_tokens WHERE user_id = ? AND kind = 'recovery'", member.id),
    ).toBe(0);
    expect((await reauth(admin.browser, admin.authenticator)).status).toBe(200);
    expect((await issue(admin.browser, member.id)).status).toBe(201);
  });

  it("a disabled member gets no link (re-enable first)", async () => {
    const member = await addMember();
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    const res = await issue(ws.browser, member.id);
    expect(res.status).toBe(409);
    expect(res.body.error.reason).toBe("member_disabled");
  });
});

describe("the link, the notices and the flag (Identity §4.6)", () => {
  it("is built from the canonical origin with the token only in the fragment, stored hashed", async () => {
    const member = await addMember();
    const res = await issue(ws.browser, member.id);
    expect(res.status).toBe(201);
    expect(res.body.link.startsWith(`${ORIGIN}/auth/recover#t=`)).toBe(true);
    const token = fragmentToken(res.body.link)!;
    expect(await count("SELECT count(*) AS n FROM auth_tokens WHERE token_hash = ?", token)).toBe(0);
    expect(res.body.expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(res.body.expiresAt - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("with email: the person is emailed at their current address and gets the banner notice; not flagged", async () => {
    const member = await addMember();
    const before = outbox.to(member.email).length;
    const res = await issue(ws.browser, member.id);
    expect(res.body).toMatchObject({ notifiedByEmail: true, flagged: false });
    const mail = outbox.to(member.email).slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.kind).toBe("security_notice");
    expect(mail[0]!.text).toContain("Sam Lee issued a recovery link for your account");
    // The email never carries the link itself.
    expect(mail[0]!.text).not.toContain(fragmentToken(res.body.link)!);
    expect(await noticeKinds(member.id)).toContain("recovery_link_issued");
    const flag = await env.DB.prepare("SELECT admin_reset_at FROM users WHERE id = ?")
      .bind(member.id)
      .first<{ admin_reset_at: number | null }>();
    expect(flag?.admin_reset_at).toBeNull();
  });

  it("without email: flagged to every owner until an owner acknowledges it; admins can't", async () => {
    await disableEmail();
    const admin = await addMember("admin");
    const member = await addMember();
    const res = await issue(admin.browser, member.id);
    expect(res.body).toMatchObject({ notifiedByEmail: false, flagged: true });

    type List = { members: { id: string; recoveryFlag: { at: number; byName: string | null } | null }[] };
    const ownerView = await ws.browser.json<List>("/api/admin/members");
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.members.find((m) => m.id === member.id)?.recoveryFlag).toMatchObject({ byName: "Pat Doe" });
    const adminView = await admin.browser.json<List>("/api/admin/members");
    expect(adminView.body.members.find((m) => m.id === member.id)?.recoveryFlag).toBeNull();
    expect((await member.browser.json("/api/admin/members")).status).toBe(403);

    expect((await admin.browser.json(`/api/admin/members/${member.id}/acknowledge-reset`, { body: {} })).status).toBe(
      403,
    );
    expect((await ws.browser.json(`/api/admin/members/${member.id}/acknowledge-reset`, { body: {} })).status).toBe(200);
    expect(await auditCount("member.reset_acknowledged", member.id)).toBe(1);
    const after = await ws.browser.json<List>("/api/admin/members");
    expect(after.body.members.find((m) => m.id === member.id)?.recoveryFlag).toBeNull();
    // Nothing left to acknowledge.
    expect((await ws.browser.json(`/api/admin/members/${member.id}/acknowledge-reset`, { body: {} })).status).toBe(404);
  });

  it("without email: the sign-in page's status names the notice for that member's browser only", async () => {
    await disableEmail();
    const member = await addMember();
    // The member signed in on this browser before, so it holds their known-device cookie.
    expect(member.browser.cookies.has("__Host-officebox-device")).toBe(true);
    await issue(ws.browser, member.id);
    const signedOut = new Browser();
    for (const [name, value] of member.browser.cookies)
      if (name === "__Host-officebox-device") signedOut.cookies.set(name, value);
    const status = await signedOut.json<{ recoveryNotice?: { at: number } }>("/api/status/public");
    expect(status.status).toBe(200);
    expect(status.body.recoveryNotice?.at).toBeGreaterThan(0);
    expect(JSON.stringify(status.body)).not.toContain(member.email);
    const stranger = await new Browser().json<{ recoveryNotice?: unknown }>("/api/status/public");
    expect(stranger.body.recoveryNotice).toBeUndefined();
  });

  it("issuing revokes the person's pending magic links and earlier recovery links", async () => {
    await setSetting("magic_link_enabled", true);
    const member = await addMember();
    const first = await issuedToken(ws.browser, member.id);
    const requester = new Browser();
    expect((await requester.call("/api/auth/sign-in/magic-link", { body: { email: member.email } })).status).toBe(200);
    const mail = outbox.to(member.email).filter((m) => m.kind === "magic_link");
    const magic = fragmentToken(mail[mail.length - 1]!.text)!;
    expect((await requester.json("/api/sign-in/link/lookup", { body: { token: magic } })).status).toBe(200);

    await issuedToken(ws.browser, member.id);
    expect((await requester.json("/api/sign-in/link", { body: { token: magic } })).status).toBe(410);
    const old = await new Browser().json<ErrorBody>("/api/auth/recover/lookup", { body: { token: first } });
    expect(old.status).toBe(410);
    expect(old.body.error.reason).toBe("recovery_link_invalid");
  });
});

describe("using a recovery link (Identity §4.6, §9)", () => {
  it("shows the email, signs out every session (closing sockets), and registers a labelled passkey once", async () => {
    const member = await addMember();
    const hub = await openHub(member.browser);
    expect(hub).not.toBeNull();
    const token = await issuedToken(ws.browser, member.id);

    const holder = new Browser();
    const lookup = await holder.json<{ email: string }>("/api/auth/recover/lookup", { body: { token } });
    expect(lookup.status).toBe(200);
    expect(lookup.body.email).toBe(member.email);
    // The lookup uses nothing.
    expect((await holder.json("/api/auth/recover/lookup", { body: { token } })).status).toBe(200);

    const calls: [string, string, RevocationScope][] = [];
    const stop = onRevocation((userId, reason, scope) => calls.push([userId, reason, scope]));
    let opened;
    try {
      opened = await holder.json<{ email: string; enrolmentExpiresInSeconds: number }>("/api/auth/recover", {
        body: { token },
      });
    } finally {
      stop();
    }
    expect(opened.status).toBe(201);
    expect(opened.body.email).toBe(member.email);
    expect(JSON.stringify(opened.body)).not.toContain(token);
    expect(holder.cookies.get("__Host-officebox-enrol")).toBeTruthy();
    expect(calls).toContainEqual([member.id, "session_revoked", "all"]);
    expect(await sessionsOf(member.id)).toBe(0);
    expect((await member.browser.call("/api/me")).status).toBe(401);
    expect(await within(hub!.closed, 5000)).toBe(WS_CLOSE_SESSION_REVOKED);

    const authenticator = new SoftAuthenticator();
    const reg = await registerAt(holder, authenticator);
    expect(reg.verify?.status).toBe(200);
    expect(holder.sessionCookie).toBeTruthy();
    const passkeys = await env.DB.prepare("SELECT created_via FROM passkeys WHERE user_id = ? ORDER BY created_at")
      .bind(member.id)
      .all<{ created_via: string }>();
    // The old passkey stays listed so the person can remove a lost one.
    expect(passkeys.results.map((p) => p.created_via)).toEqual(["invitation", "recovery_link"]);
    expect(await noticeKinds(member.id)).toEqual(
      expect.arrayContaining(["recovery_link_issued", "recovery_link_used"]),
    );
    expect(await auditCount("auth.recovery_link_used")).toBeGreaterThan(0);
    // The person is signed in with a fresh passkey session.
    expect((await holder.call("/api/me")).status).toBe(200);

    // Used up: opening it again answers 410.
    expect((await new Browser().json("/api/auth/recover/lookup", { body: { token } })).status).toBe(410);
    expect((await new Browser().json("/api/auth/recover", { body: { token } })).status).toBe(410);
  });

  it("can be resumed until a passkey is registered; each opening replaces the person's other tickets", async () => {
    const member = await addMember();
    const token = await issuedToken(ws.browser, member.id);
    const first = new Browser();
    expect((await first.json("/api/auth/recover", { body: { token } })).status).toBe(201);
    const second = new Browser();
    expect((await second.json("/api/auth/recover", { body: { token } })).status).toBe(201);
    // The first browser's ticket was revoked by the second opening.
    const stale = await registerAt(first, new SoftAuthenticator());
    expect(stale.options.status).not.toBe(200);
    const reg = await registerAt(second, new SoftAuthenticator());
    expect(reg.verify?.status).toBe(200);
    expect((await new Browser().json("/api/auth/recover", { body: { token } })).status).toBe(410);
  });

  it("invalidates other outstanding enrolment tickets of the person (an invitation's, for example)", async () => {
    const member = await addMember();
    const { giveTicket } = await import("./helpers");
    const elsewhere = new Browser();
    await giveTicket(elsewhere, member.id, "invitation");
    const token = await issuedToken(ws.browser, member.id);
    expect((await new Browser().json("/api/auth/recover", { body: { token } })).status).toBe(201);
    const refused = await registerAt(elsewhere, new SoftAuthenticator());
    expect(refused.options.status).not.toBe(200);
  });

  it("two concurrent registrations with one recovery ticket add at most one passkey", async () => {
    const member = await addMember();
    const token = await issuedToken(ws.browser, member.id);
    const holder = new Browser();
    expect((await holder.json("/api/auth/recover", { body: { token } })).status).toBe(201);
    const options = await holder.json<{
      challenge: string;
      rp: { id: string; name: string };
      user: { id: string; name: string };
    }>("/api/auth/passkey/generate-register-options");
    const a = await new SoftAuthenticator().register(options.body, ORIGIN);
    const b = await new SoftAuthenticator().register(options.body, ORIGIN);
    const [ra, rb] = await Promise.all([
      holder.json("/api/auth/passkey/verify-registration", { body: { response: a.response } }),
      holder.json("/api/auth/passkey/verify-registration", { body: { response: b.response } }),
    ]);
    expect([ra.status, rb.status].filter((s) => s === 200)).toHaveLength(1);
    expect(
      await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ? AND created_via = 'recovery_link'", member.id),
    ).toBe(1);
  });

  it("an expired, revoked or unknown link answers 410; a disabled account's link too", async () => {
    const member = await addMember();
    const token = await issuedToken(ws.browser, member.id);
    await env.DB.prepare("UPDATE auth_tokens SET expires_at = ? WHERE user_id = ? AND kind = 'recovery'")
      .bind(Date.now() - 1, member.id)
      .run();
    expect((await new Browser().json("/api/auth/recover", { body: { token } })).status).toBe(410);
    expect((await new Browser().json("/api/auth/recover/lookup", { body: { token: "x".repeat(43) } })).status).toBe(
      410,
    );

    const other = await addMember();
    const live = await issuedToken(ws.browser, other.id);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(other.id).run();
    expect((await new Browser().json("/api/auth/recover", { body: { token: live } })).status).toBe(410);
  });

  it("refuses a malformed body and extra fields", async () => {
    expect((await new Browser().json("/api/auth/recover", { body: { token: "short" } })).status).toBe(400);
    expect(
      (await new Browser().json("/api/auth/recover", { body: { token: "x".repeat(43), userId: ws.ownerId } })).status,
    ).toBe(400);
  });

  it("needs the CSRF header like every state change", async () => {
    expect(
      (await new Browser().call("/api/auth/recover", { body: { token: "x".repeat(43) }, noCsrf: true })).status,
    ).toBe(403);
  });
});

// ---- Owner recovery with RECOVERY_TOKEN -------------------------------------------------------------

const freshSecret = () => `recovery-${crypto.randomUUID()}-${crypto.randomUUID()}`;

function recover(browser: Browser, secret: string | undefined, body: Record<string, unknown>) {
  return browser.json<{ email: string; enrolmentExpiresInSeconds: number } & ErrorBody>("/api/recover", {
    body,
    env: { RECOVERY_TOKEN: secret },
  });
}

describe("owner recovery with RECOVERY_TOKEN (Identity §4.6, §9)", () => {
  it("answers 404 without the secret, or with one shorter than 32 characters", async () => {
    const res = await recover(new Browser(), undefined, { token: "anything", email: ws.owner.email });
    expect(res.status).toBe(404);
    const short = await recover(new Browser(), "too-short-0123456789", {
      token: "too-short-0123456789",
      email: ws.owner.email,
    });
    expect(short.status).toBe(404);
  });

  it("registers a new passkey for one owner once; the value then never works again; a fresh value does", async () => {
    const owner = await addMember("owner");
    const otherOwner = await addMember("owner");
    const secret = freshSecret();
    const browser = new Browser();
    const calls: [string, RevocationScope][] = [];
    const stop = onRevocation((userId, _reason, scope) => calls.push([userId, scope]));
    let res;
    try {
      res = await recover(browser, secret, { token: secret, email: owner.email.toUpperCase() });
    } finally {
      stop();
    }
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(owner.email);
    expect(calls).toContainEqual([owner.id, "all"]);
    expect(await sessionsOf(owner.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM recovery_token_uses WHERE owner_id = ?", owner.id)).toBe(1);
    // The secret's hash is recorded, never the secret.
    expect(await count("SELECT count(*) AS n FROM recovery_token_uses WHERE token_hash = ?", secret)).toBe(0);

    const reg = await registerAt(browser, new SoftAuthenticator());
    expect(reg.verify?.status).toBe(200);
    expect(
      await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ? AND created_via = 'owner_recovery'", owner.id),
    ).toBe(1);
    // The other owners are told; the recovered owner gets the passkey notice.
    expect(await noticeKinds(otherOwner.id)).toContain("owner_recovery_used");
    expect(await noticeKinds(ws.ownerId)).toContain("owner_recovery_used");
    expect(await noticeKinds(owner.id)).not.toContain("owner_recovery_used");
    expect(await auditCount("auth.owner_recovery_used", owner.id)).toBe(1);

    const again = await recover(new Browser(), secret, { token: secret, email: owner.email });
    expect(again.status).toBe(410);
    expect(again.body.error.reason).toBe("recovery_token_used");

    const next = freshSecret();
    expect((await recover(new Browser(), next, { token: next, email: owner.email })).status).toBe(201);
  });

  it("a wrong value is refused and consumes nothing; a non-owner's email is refused and consumes nothing", async () => {
    const secret = freshSecret();
    const wrong = await recover(new Browser(), secret, { token: `${secret}x`, email: ws.owner.email });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.reason).toBe("recovery_token_invalid");
    const member = await addMember();
    const notOwner = await recover(new Browser(), secret, { token: secret, email: member.email });
    expect(notOwner.status).toBe(404);
    expect(notOwner.body.error.reason).toBe("owner_not_found");
    const unknown = await recover(new Browser(), secret, { token: secret, email: uniqueEmail("nobody") });
    expect(unknown.status).toBe(404);
    const total = await count("SELECT count(*) AS n FROM recovery_token_uses");
    const owner = await addMember("owner");
    expect((await recover(new Browser(), secret, { token: secret, email: owner.email })).status).toBe(201);
    expect(await count("SELECT count(*) AS n FROM recovery_token_uses")).toBe(total + 1);
  });

  it("two concurrent uses of one value succeed at most once", async () => {
    const owner = await addMember("owner");
    const secret = freshSecret();
    const [a, b] = await Promise.all([
      recover(new Browser(), secret, { token: secret, email: owner.email }),
      recover(new Browser(), secret, { token: secret, email: owner.email }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 410]);
  });

  it("is limited per IP (5 a minute): the 6th attempt is rate_limited, before the secret is compared", async () => {
    const secret = freshSecret();
    const browser = new Browser();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await recover(browser, secret, { token: "wrong-wrong-wrong-wrong-wrong-wrong", email: ws.owner.email }))
          .status,
      );
    }
    expect(statuses.slice(0, 5).every((s) => s === 403)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("owners see the banner flag while a used value is still set; it clears when the secret changes", async () => {
    const owner = await addMember("owner");
    const secret = freshSecret();
    expect((await recover(new Browser(), secret, { token: secret, email: owner.email })).status).toBe(201);
    const me = await ws.browser.json<{ ownerRecoveryUsed?: boolean }>("/api/me", { env: { RECOVERY_TOKEN: secret } });
    expect(me.body.ownerRecoveryUsed).toBe(true);
    const changed = await ws.browser.json<{ ownerRecoveryUsed?: boolean }>("/api/me", {
      env: { RECOVERY_TOKEN: freshSecret() },
    });
    expect(changed.body.ownerRecoveryUsed).toBe(false);
    const member = await addMember();
    const memberMe = await member.browser.json<{ ownerRecoveryUsed?: boolean }>("/api/me", {
      env: { RECOVERY_TOKEN: secret },
    });
    expect(memberMe.body.ownerRecoveryUsed).toBeUndefined();
  });

  it("a consumed value no longer satisfies the owners' invite gate (Identity §2)", async () => {
    const owner = await addMember("owner");
    const secret = freshSecret();
    const invite = () =>
      owner.browser.json<ErrorBody>("/api/admin/invitations", {
        body: { email: uniqueEmail("gate"), role: "member", sendEmail: false },
        env: { RECOVERY_TOKEN: secret },
      });
    expect((await invite()).status).toBe(201);
    expect((await recover(new Browser(), secret, { token: secret, email: ws.owner.email })).status).toBe(201);
    const refused = await invite();
    expect(refused.status).toBe(403);
    expect(refused.body.error.reason).toBe("owner_invite_gate");
    // The owner whose sessions were revoked signs back in (other tests use this browser).
    const again = await signInWithPasskey(ws.browser, ws.authenticator);
    expect(again.verify.status).toBe(200);
  });
});

describe("review fixes (M1c)", () => {
  it("a link stops working when its issuer may no longer issue it: demoted, disabled, or the target promoted", async () => {
    const tryLink = async (token: string) => new Browser().json<ErrorBody>("/api/auth/recover", { body: { token } });

    const demoted = await addMember("admin");
    const a = await addMember();
    const tokenA = await issuedToken(demoted.browser, a.id);
    await env.DB.prepare("UPDATE users SET role = 'member' WHERE id = ?").bind(demoted.id).run();
    const refusedA = await tryLink(tokenA);
    expect(refusedA.status).toBe(410);
    expect(refusedA.body.error.reason).toBe("recovery_link_issuer_changed");
    const lookup = await new Browser().json<ErrorBody>("/api/auth/recover/lookup", { body: { token: tokenA } });
    expect(lookup.body.error.reason).toBe("recovery_link_issuer_changed");
    // Nothing happened to the target: their session still works.
    expect((await a.browser.call("/api/me")).status).toBe(200);

    const disabled = await addMember("admin");
    const b = await addMember();
    const tokenB = await issuedToken(disabled.browser, b.id);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(disabled.id).run();
    expect((await tryLink(tokenB)).body.error.reason).toBe("recovery_link_issuer_changed");

    const admin = await addMember("admin");
    const c = await addMember();
    const tokenC = await issuedToken(admin.browser, c.id);
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(c.id).run();
    expect((await tryLink(tokenC)).body.error.reason).toBe("recovery_link_issuer_changed");

    // An owner's link for an admin still works.
    const target = await addMember("admin");
    expect((await tryLink(await issuedToken(ws.browser, target.id))).status).toBe(201);
  });

  it("one link registers one passkey, even with two live tickets for it at once", async () => {
    const member = await addMember();
    const token = await issuedToken(ws.browser, member.id);
    const first = new Browser();
    const second = new Browser();
    expect((await first.json("/api/auth/recover", { body: { token } })).status).toBe(201);
    expect((await second.json("/api/auth/recover", { body: { token } })).status).toBe(201);
    // Undo the second opening's revocation of the first ticket: both are live.
    await env.DB.prepare(
      "UPDATE auth_tokens SET revoked_at = NULL WHERE user_id = ? AND kind = 'passkey_enrol' AND used_at IS NULL",
    )
      .bind(member.id)
      .run();
    type Options = { challenge: string; rp: { id: string; name: string }; user: { id: string; name: string } };
    const o1 = await first.json<Options>("/api/auth/passkey/generate-register-options");
    const o2 = await second.json<Options>("/api/auth/passkey/generate-register-options");
    expect([o1.status, o2.status]).toEqual([200, 200]);
    const r1 = await new SoftAuthenticator().register(o1.body, ORIGIN);
    const r2 = await new SoftAuthenticator().register(o2.body, ORIGIN);
    const results = await Promise.all([
      first.json("/api/auth/passkey/verify-registration", { body: { response: r1.response } }),
      second.json("/api/auth/passkey/verify-registration", { body: { response: r2.response } }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ? AND created_via = 'recovery_link'", member.id),
    ).toBe(1);
  });

  it("RECOVERY_TOKEN uses are keyed by plain SHA-256; a row keyed the older way still counts as used", async () => {
    const owner = await addMember("owner");
    const secret = freshSecret();
    expect((await recover(new Browser(), secret, { token: secret, email: owner.email })).status).toBe(201);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
    const { base64url, tokenHash } = await import("../../src/features/identity/crypto");
    expect(
      await count("SELECT count(*) AS n FROM recovery_token_uses WHERE token_hash = ?", `sha256:${base64url(digest)}`),
    ).toBe(1);

    // A value recorded before the change (HMAC-keyed) is still used up.
    const older = freshSecret();
    await env.DB.prepare("INSERT INTO recovery_token_uses (token_hash, owner_id, used_at) VALUES (?, ?, ?)")
      .bind(await tokenHash(env.TOKEN_HASH_KEY!, older), owner.id, Date.now())
      .run();
    const refused = await recover(new Browser(), older, { token: older, email: owner.email });
    expect(refused.status).toBe(410);
    const me = await ws.browser.json<{ ownerRecoveryUsed?: boolean }>("/api/me", { env: { RECOVERY_TOKEN: older } });
    expect(me.body.ownerRecoveryUsed).toBe(true);
  });
});
