import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { SoftAuthenticator } from "./authenticator";
import {
  addMember,
  Browser,
  giveTicket,
  ORIGIN,
  reauth,
  registerPasskey,
  setupWorkspace,
  signInWithPasskey,
  staleFreshAuth,
  type Workspace,
} from "./helpers";

const count = async (sql: string, ...params: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;
const sessionsOf = (userId: string) => count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId);
const passkeysOf = (userId: string) => count("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", userId);

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
});

describe("passkey sign-in (Identity §4.4)", () => {
  it("signs in with a discoverable passkey; options require user verification", async () => {
    const browser = new Browser();
    const { options, verify } = await signInWithPasskey(browser, ws.authenticator);
    expect(options.body.userVerification).toBe("required");
    expect(options.body.rpId).toBe("officebox.test");
    expect(verify.status).toBe(200);
    expect(browser.sessionCookie).toBeTruthy();
    const me = await browser.json<{ user: { id: string }; session: { freshAuthMethod: string } }>("/api/me");
    expect(me.body.user.id).toBe(ws.ownerId);
    expect(me.body.session.freshAuthMethod).toBe("passkey");
  });

  it("stores the counter and the last-used time", async () => {
    const browser = new Browser();
    await signInWithPasskey(browser, ws.authenticator);
    const row = await env.DB.prepare("SELECT sign_count, last_used_at FROM passkeys WHERE user_id = ?")
      .bind(ws.ownerId)
      .first<{ sign_count: number; last_used_at: number }>();
    expect(row!.sign_count).toBeGreaterThan(0);
    expect(typeof row!.last_used_at).toBe("number");
  });

  it("refuses an assertion without user verification, leaving no session", async () => {
    const browser = new Browser();
    const before = await sessionsOf(ws.ownerId);
    const { verify } = await signInWithPasskey(browser, ws.authenticator, { uv: false });
    expect(verify.status).toBe(403);
    expect(verify.body).toMatchObject({ error: { code: "forbidden", reason: "USER_VERIFICATION_REQUIRED" } });
    expect(browser.sessionCookie).toBeUndefined();
    expect(await sessionsOf(ws.ownerId)).toBe(before);
  });

  it("refuses an assertion made for another origin", async () => {
    const browser = new Browser();
    const { verify } = await signInWithPasskey(browser, ws.authenticator, { origin: "https://evil.test" });
    expect(verify.status).toBeGreaterThanOrEqual(400);
    expect(browser.sessionCookie).toBeUndefined();
  });

  it("refuses an assertion made for another relying-party ID", async () => {
    const browser = new Browser();
    const { verify } = await signInWithPasskey(browser, ws.authenticator, { rpId: "evil.test" });
    expect(verify.status).toBeGreaterThanOrEqual(400);
    expect(browser.sessionCookie).toBeUndefined();
  });

  it("refuses an unknown credential", async () => {
    const browser = new Browser();
    const stranger = new SoftAuthenticator();
    await stranger.register(
      { challenge: "x", rp: { id: "officebox.test", name: "x" }, user: { id: "u", name: "u" } },
      ORIGIN,
    );
    const { verify } = await signInWithPasskey(browser, stranger);
    expect(verify.status).toBe(401);
    expect(browser.sessionCookie).toBeUndefined();
  });

  it("an authenticator that always reports a counter of 0 still signs in, again and again", async () => {
    const member = await addMember();
    const synced = new SoftAuthenticator({ counter: "zero" });
    await giveTicket(member.browser, member.id);
    member.browser.cookies.delete("__Host-officebox.session_token");
    const reg = await registerPasskey(member.browser, synced);
    expect(reg.verify?.status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const browser = new Browser();
      const { verify } = await signInWithPasskey(browser, synced);
      expect(verify.status).toBe(200);
    }
  });
});

describe("clone detection (Identity §4.4; M1a-0 decision: re-verify refused assertions)", () => {
  it("refuses a counter at or below the stored one as clone_detected, with no session and notices", async () => {
    const member = await addMember();
    // Two genuine sign-ins move the counter to 3.
    await signInWithPasskey(new Browser(), member.authenticator);
    await signInWithPasskey(new Browser(), member.authenticator);
    const stored = (await env.DB.prepare("SELECT sign_count FROM passkeys WHERE user_id = ?")
      .bind(member.id)
      .first<{ sign_count: number }>())!.sign_count;
    const sessionsBefore = await sessionsOf(member.id);

    const browser = new Browser();
    const { verify } = await signInWithPasskey(browser, member.authenticator, { counter: stored });
    expect(verify.status).toBe(403);
    expect(verify.body).toMatchObject({ error: { code: "forbidden", reason: "clone_detected" } });
    expect(browser.sessionCookie).toBeUndefined();
    expect(await sessionsOf(member.id)).toBe(sessionsBefore);
    const after = (await env.DB.prepare("SELECT sign_count FROM passkeys WHERE user_id = ?")
      .bind(member.id)
      .first<{ sign_count: number }>())!.sign_count;
    expect(after).toBe(stored);

    // The member and every owner get a notice; it's audited.
    const notices = async (id: string) =>
      (await env.DB.prepare("SELECT pending_security_notice AS p FROM users WHERE id = ?")
        .bind(id)
        .first<{ p: string }>())!.p;
    expect(JSON.parse(await notices(member.id))).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "passkey_clone_detected" })]),
    );
    expect(JSON.parse(await notices(ws.ownerId))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "passkey_clone_detected", details: { subjectName: "Pat Doe" } }),
      ]),
    );
    expect(
      await count("SELECT count(*) AS n FROM audit_log WHERE action = 'auth.passkey_clone_detected'"),
    ).toBeGreaterThan(0);
  });

  it("a lower counter is a clone too; a forged signature is an ordinary failure, not a clone", async () => {
    const member = await addMember();
    await signInWithPasskey(new Browser(), member.authenticator);
    await signInWithPasskey(new Browser(), member.authenticator);
    const lower = await signInWithPasskey(new Browser(), member.authenticator, { counter: 1 });
    expect(lower.verify.body).toMatchObject({ error: { reason: "clone_detected" } });

    // Another key presenting the member's credential ID with a low counter: not genuine, so not a clone.
    const browser = new Browser();
    const options = await browser.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
    const forger = new SoftAuthenticator();
    const fake = await forger.register(
      { challenge: "x", rp: { id: "officebox.test", name: "x" }, user: { id: "u", name: "u" } },
      ORIGIN,
    );
    const credential = { ...fake.credential, id: member.authenticator.credentials[0]!.id };
    const forged = await forger.authenticate(options.body, ORIGIN, { credential, counter: 1 });
    const verify = await browser.json("/api/auth/passkey/verify-authentication", { body: { response: forged } });
    expect(verify.status).toBe(400);
    expect((verify.body as { error: { reason?: string } }).error.reason).toBe("AUTHENTICATION_FAILED");
  });

  const cloneAudits = () => count("SELECT count(*) AS n FROM audit_log WHERE action = 'auth.passkey_clone_detected'");
  const noticesOf = async (id: string) =>
    (await env.DB.prepare("SELECT pending_security_notice AS p FROM users WHERE id = ?")
      .bind(id)
      .first<{ p: string | null }>())!.p;

  it("two legitimate sign-ins verified out of order (B before A): A is refused quietly, no clone, no notices", async () => {
    const member = await addMember();
    const audits = await cloneAudits();
    const ownerNotices = await noticesOf(ws.ownerId);
    const a = new Browser();
    const b = new Browser();
    const oa = await a.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
    const ob = await b.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
    const ra = await member.authenticator.authenticate(oa.body, ORIGIN); // counter n+1
    const rb = await member.authenticator.authenticate(ob.body, ORIGIN); // counter n+2
    const vb = await b.json("/api/auth/passkey/verify-authentication", { body: { response: rb } });
    expect(vb.status).toBe(200);
    const va = await a.json("/api/auth/passkey/verify-authentication", { body: { response: ra } });
    expect(va.status).toBe(400);
    expect((va.body as { error: { reason?: string } }).error.reason).toBe("AUTHENTICATION_FAILED");
    expect(a.sessionCookie).toBeUndefined();
    expect(await cloneAudits()).toBe(audits);
    expect(await noticesOf(member.id)).toBeNull();
    expect(await noticesOf(ws.ownerId)).toBe(ownerNotices);
    // The person simply tries again.
    expect((await signInWithPasskey(a, member.authenticator)).verify.status).toBe(200);
  });

  it("a true clone is still clone_detected after legitimate sign-ins moved the counter", async () => {
    const member = await addMember();
    await signInWithPasskey(new Browser(), member.authenticator); // a non-zero stored counter
    const browser = new Browser();
    // The cloner's challenge is issued first; then the real owner signs in twice.
    const options = await browser.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
    const stored = (await env.DB.prepare("SELECT sign_count FROM passkeys WHERE user_id = ?")
      .bind(member.id)
      .first<{ sign_count: number }>())!.sign_count;
    await signInWithPasskey(new Browser(), member.authenticator);
    await signInWithPasskey(new Browser(), member.authenticator);
    const cloned = await member.authenticator.authenticate(options.body, ORIGIN, { counter: stored });
    const verify = await browser.json("/api/auth/passkey/verify-authentication", { body: { response: cloned } });
    expect(verify.body).toMatchObject({ error: { reason: "clone_detected" } });
  });

  it("both counters 0 is never a clone (synced passkeys)", async () => {
    const member = await addMember();
    const synced = new SoftAuthenticator({ counter: "zero" });
    await giveTicket(member.browser, member.id);
    member.browser.cookies.delete("__Host-officebox.session_token");
    await registerPasskey(member.browser, synced);
    const audits = await cloneAudits();
    const a = new Browser();
    const b = new Browser();
    const oa = await a.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
    const ob = await b.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
    const ra = await synced.authenticate(oa.body, ORIGIN);
    const rb = await synced.authenticate(ob.body, ORIGIN);
    expect((await b.json("/api/auth/passkey/verify-authentication", { body: { response: rb } })).status).toBe(200);
    expect((await a.json("/api/auth/passkey/verify-authentication", { body: { response: ra } })).status).toBe(200);
    expect(await cloneAudits()).toBe(audits);
  });

  it("the same assertion sent twice at once signs in at most once and raises nothing", async () => {
    const member = await addMember();
    const audits = await cloneAudits();
    const browser = new Browser();
    const options = await browser.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
    const response = await member.authenticator.authenticate(options.body, ORIGIN);
    const twin = new Browser();
    for (const [k, v] of browser.cookies) twin.cookies.set(k, v);
    const results = await Promise.all([
      browser.json("/api/auth/passkey/verify-authentication", { body: { response } }),
      twin.json("/api/auth/passkey/verify-authentication", { body: { response } }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await cloneAudits()).toBe(audits);
  });

  it("the stored counter never goes backwards after a lost update", async () => {
    const member = await addMember();
    await signInWithPasskey(new Browser(), member.authenticator);
    const row = (await env.DB.prepare("SELECT id, sign_count FROM passkeys WHERE user_id = ?").bind(member.id).first<{
      id: string;
      sign_count: number;
    }>())!;
    // As if a slower verify had written an older value over a newer one.
    await env.DB.prepare("UPDATE passkeys SET sign_count = ? WHERE id = ?")
      .bind(row.sign_count - 1, row.id)
      .run();
    await signInWithPasskey(new Browser(), member.authenticator);
    const after = (await env.DB.prepare("SELECT sign_count FROM passkeys WHERE id = ?")
      .bind(row.id)
      .first<{ sign_count: number }>())!;
    expect(after.sign_count).toBe(row.sign_count + 1);
  });

  it("two legitimate concurrent sign-ins never raise a clone alert", async () => {
    const member = await addMember();
    const before = await count("SELECT count(*) AS n FROM audit_log WHERE action = 'auth.passkey_clone_detected'");
    const a = new Browser();
    const b = new Browser();
    const [oa, ob] = await Promise.all([
      a.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options"),
      b.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options"),
    ]);
    const ra = await member.authenticator.authenticate(oa.body, ORIGIN);
    const rb = await member.authenticator.authenticate(ob.body, ORIGIN);
    const results = await Promise.all([
      a.json("/api/auth/passkey/verify-authentication", { body: { response: ra } }),
      b.json("/api/auth/passkey/verify-authentication", { body: { response: rb } }),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'auth.passkey_clone_detected'")).toBe(
      before,
    );
  });
});

describe("enrolment tickets (Identity §4.4, §9 'Enrolment tickets')", () => {
  it("registration without a session or a ticket is refused", async () => {
    const browser = new Browser();
    const options = await browser.json("/api/auth/passkey/generate-register-options");
    expect(options.status).toBe(403);
    expect(options.body).toMatchObject({ error: { reason: "ENROLMENT_TICKET_REQUIRED" } });
    const verify = await browser.json("/api/auth/passkey/verify-registration", {
      body: { response: { id: "x", type: "public-key" } },
    });
    expect(verify.status).toBe(403);
  });

  it("is consumed at verify, not at options, and only once", async () => {
    const member = await addMember();
    const browser = new Browser();
    await giveTicket(browser, member.id);
    // Options twice: nothing consumed.
    await browser.json("/api/auth/passkey/generate-register-options");
    const second = await browser.json<{
      challenge: string;
      rp: { id: string; name: string };
      user: { id: string; name: string };
    }>("/api/auth/passkey/generate-register-options");
    expect(second.status).toBe(200);
    const ticket = browser.cookies.get("__Host-officebox-enrol")!;
    const authenticator = new SoftAuthenticator();
    const { response } = await authenticator.register(second.body, ORIGIN);
    const verify = await browser.json("/api/auth/passkey/verify-registration", { body: { response } });
    expect(verify.status).toBe(200);
    // The ticket cookie is cleared, and the ticket can't be used again.
    expect(browser.cookies.has("__Host-officebox-enrol")).toBe(false);
    const again = new Browser();
    again.cookies.set("__Host-officebox-enrol", ticket);
    expect((await again.json("/api/auth/passkey/generate-register-options")).status).toBe(403);
  });

  it("is bound to the challenge: a registration answering an older challenge is refused", async () => {
    const member = await addMember();
    const browser = new Browser();
    await giveTicket(browser, member.id);
    const first = await browser.json<{
      challenge: string;
      rp: { id: string; name: string };
      user: { id: string; name: string };
    }>("/api/auth/passkey/generate-register-options");
    // A second browser holding the same ticket generates fresh options: the ticket moves to that challenge.
    const other = new Browser();
    other.cookies.set("__Host-officebox-enrol", browser.cookies.get("__Host-officebox-enrol")!);
    await other.json("/api/auth/passkey/generate-register-options");
    const { response } = await new SoftAuthenticator().register(first.body, ORIGIN);
    const verify = await browser.json("/api/auth/passkey/verify-registration", { body: { response } });
    expect(verify.status).toBe(403);
    expect(verify.body).toMatchObject({ error: { reason: "ENROLMENT_TICKET_INVALID" } });
  });

  it("two concurrent verifies with one ticket register at most one passkey", async () => {
    const member = await addMember();
    const before = await passkeysOf(member.id);
    const browser = new Browser();
    await giveTicket(browser, member.id);
    const options = await browser.json<{
      challenge: string;
      rp: { id: string; name: string };
      user: { id: string; name: string };
    }>("/api/auth/passkey/generate-register-options");
    const one = await new SoftAuthenticator().register(options.body, ORIGIN);
    const two = await new SoftAuthenticator().register(options.body, ORIGIN);
    const twin = new Browser();
    for (const [k, v] of browser.cookies) twin.cookies.set(k, v);
    const results = await Promise.all([
      browser.json("/api/auth/passkey/verify-registration", { body: { response: one.response } }),
      twin.json("/api/auth/passkey/verify-registration", { body: { response: two.response } }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await passkeysOf(member.id)).toBe(before + 1);
  });

  it("a ticket whose user was disabled after options is refused at verify", async () => {
    const member = await addMember();
    const browser = new Browser();
    await giveTicket(browser, member.id);
    const options = await browser.json<{
      challenge: string;
      rp: { id: string; name: string };
      user: { id: string; name: string };
    }>("/api/auth/passkey/generate-register-options");
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    const { response } = await new SoftAuthenticator().register(options.body, ORIGIN);
    const verify = await browser.json("/api/auth/passkey/verify-registration", { body: { response } });
    expect(verify.status).toBe(403);
    expect(verify.body).toMatchObject({ error: { reason: "ENROLMENT_TICKET_INVALID" } });
  });

  it("an expired ticket is refused", async () => {
    const member = await addMember();
    const browser = new Browser();
    await giveTicket(browser, member.id);
    await env.DB.prepare("UPDATE auth_tokens SET expires_at = ? WHERE user_id = ? AND used_at IS NULL")
      .bind(Date.now() - 1, member.id)
      .run();
    expect((await browser.json("/api/auth/passkey/generate-register-options")).status).toBe(403);
  });

  it("refuses a registration without user verification, storing no passkey", async () => {
    const member = await addMember();
    const before = await passkeysOf(member.id);
    const browser = new Browser();
    await giveTicket(browser, member.id);
    const reg = await registerPasskey(browser, new SoftAuthenticator({ uv: false }));
    expect(reg.verify?.status).toBe(403);
    expect(reg.verify?.body).toMatchObject({ error: { reason: "USER_VERIFICATION_REQUIRED" } });
    expect(await passkeysOf(member.id)).toBe(before);
  });
});

describe("signed-in passkey management (Identity §4.4, §6)", () => {
  it("adding a passkey needs step-up, then works, labels it and raises a notice", async () => {
    const member = await addMember();
    await staleFreshAuth(member.id);
    const second = new SoftAuthenticator();
    const refused = await registerPasskey(member.browser, second);
    expect(refused.options.status).toBe(403);
    expect(refused.options.body).toMatchObject({ error: { code: "reauth_required", reason: "reauth_required" } });

    const sessionsBefore = await sessionsOf(member.id);
    expect((await reauth(member.browser, member.authenticator)).status).toBe(200);
    // createSession is stripped for a signed-in registration: no second session.
    const added = await registerPasskey(member.browser, second, {}, { createSession: true });
    expect(added.verify?.status).toBe(200);
    expect(await sessionsOf(member.id)).toBe(sessionsBefore);

    const list = await member.browser.json<{ passkeys: { createdVia: string }[] }>("/api/me/passkeys");
    expect(list.body.passkeys.map((p) => p.createdVia).sort()).toEqual(["invitation", "signed_in"]);
    const me = await member.browser.json<{ securityNotices: { kind: string; details: { createdVia: string } }[] }>(
      "/api/me",
    );
    expect(me.body.securityNotices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "passkey_added",
          details: expect.objectContaining({ createdVia: "signed_in" }) as unknown,
        }),
      ]),
    );
  });

  it("the first passkey at setup raises no notice", async () => {
    const me = await ws.browser.json<{ securityNotices: { kind: string }[] }>("/api/me");
    expect(me.body.securityNotices.filter((n) => n.kind === "passkey_added")).toEqual([]);
  });

  it("renames own passkeys; another member's answers 404", async () => {
    const member = await addMember();
    const other = await addMember();
    const { body } = await member.browser.json<{ passkeys: { id: string }[] }>("/api/me/passkeys");
    const id = body.passkeys[0]!.id;
    const renamed = await member.browser.json<{ name: string }>(`/api/me/passkeys/${id}`, {
      method: "PATCH",
      body: { name: "Work laptop" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Work laptop");
    const foreign = await other.browser.json(`/api/me/passkeys/${id}`, { method: "PATCH", body: { name: "Mine now" } });
    expect(foreign.status).toBe(404);
    expect((await other.browser.json(`/api/me/passkeys/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("removing needs step-up; the last passkey can't be removed", async () => {
    const member = await addMember();
    await registerPasskey(member.browser, new SoftAuthenticator()); // fresh from the ticket sign-in
    const { body } = await member.browser.json<{ passkeys: { id: string }[] }>("/api/me/passkeys");
    expect(body.passkeys).toHaveLength(2);
    await staleFreshAuth(member.id);
    const stale = await member.browser.json(`/api/me/passkeys/${body.passkeys[1]!.id}`, { method: "DELETE" });
    expect(stale.body).toMatchObject({ error: { code: "reauth_required" } });
    await reauth(member.browser, member.authenticator);
    expect((await member.browser.json(`/api/me/passkeys/${body.passkeys[1]!.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    // The engine refuses for the rule before asking for step-up: the last passkey is never removable.
    await staleFreshAuth(member.id);
    const last = await member.browser.json(`/api/me/passkeys/${body.passkeys[0]!.id}`, { method: "DELETE" });
    expect(last.status).toBe(403);
    expect(last.body).toMatchObject({ error: { reason: "last_passkey" } });
    expect(await passkeysOf(member.id)).toBe(1);
  });

  it("removes one of two passkeys; two concurrent removals leave one", async () => {
    const member = await addMember();
    await reauth(member.browser, member.authenticator);
    await registerPasskey(member.browser, new SoftAuthenticator());
    const { body } = await member.browser.json<{ passkeys: { id: string }[] }>("/api/me/passkeys");
    expect(body.passkeys).toHaveLength(2);
    const results = await Promise.all(
      body.passkeys.map((p) => member.browser.json(`/api/me/passkeys/${p.id}`, { method: "DELETE" })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await passkeysOf(member.id)).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM audit_log WHERE action = 'passkey.removed' AND actor_id = ?", member.id),
    ).toBe(1);
  });

  it("an owner can never remove their last passkey", async () => {
    await reauth(ws.browser, ws.authenticator);
    const { body } = await ws.browser.json<{ passkeys: { id: string }[] }>("/api/me/passkeys");
    if (body.passkeys.length !== 1) return; // other tests may have added one
    const result = await ws.browser.json(`/api/me/passkeys/${body.passkeys[0]!.id}`, { method: "DELETE" });
    expect(result.body).toMatchObject({ error: { reason: "last_passkey" } });
  });

  it("passkey routes need a session", async () => {
    const browser = new Browser();
    expect((await browser.json("/api/me/passkeys")).status).toBe(401);
  });
});
