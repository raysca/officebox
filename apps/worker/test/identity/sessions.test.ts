import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { onRevocation, type RevocationScope } from "../../src/features/identity/revocation";
import { SoftAuthenticator } from "./authenticator";
import {
  addMember,
  Browser,
  ORIGIN,
  reauth,
  setupWorkspace,
  signInWithPasskey,
  staleFreshAuth,
  type Workspace,
} from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
});
afterEach(() => {
  vi.useRealTimers();
});

async function signedIn(member: { authenticator: SoftAuthenticator }) {
  const browser = new Browser();
  const { verify } = await signInWithPasskey(browser, member.authenticator);
  expect(verify.status).toBe(200);
  return browser;
}

const sessionsOf = async (userId: string) =>
  (await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?").bind(userId).first<{ n: number }>())!.n;

describe("better-auth sessions (Identity §4.5)", () => {
  it("the session cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, host-only, 30 days", async () => {
    const browser = new Browser();
    const options = await browser.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
    const response = await ws.authenticator.authenticate(options.body, ORIGIN);
    const res = await browser.call("/api/auth/passkey/verify-authentication", { body: { response } });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-officebox.session_token="))!;
    expect(cookie).toMatch(/; Max-Age=2592000/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("records the device label and fresh-auth facts on the session", async () => {
    const browser = await signedIn(ws);
    // This browser's own session (by its cookie's token), not "the newest", which ties within a millisecond.
    const token = decodeURIComponent(browser.sessionCookie!).split(".")[0]!;
    const row = await env.DB.prepare(
      "SELECT device_label, fresh_auth_at, fresh_auth_method, expires_at, created_at FROM sessions WHERE token = ?",
    )
      .bind(token)
      .first<{
        device_label: string;
        fresh_auth_at: number;
        fresh_auth_method: string;
        expires_at: number;
        created_at: number;
      }>();
    expect(row?.device_label).toBe("Chrome on macOS");
    expect(row?.fresh_auth_method).toBe("passkey");
    expect(typeof row?.expires_at).toBe("number"); // epoch ms, not ISO text
    // better-auth reads the clock separately for the two dates, so they can be a millisecond or two apart.
    expect(row!.expires_at - row!.created_at).toBeGreaterThanOrEqual(30 * DAY - 50);
    expect(row!.expires_at - row!.created_at).toBeLessThanOrEqual(30 * DAY);
    void browser;
  });

  it("a session unused for 30 days is rejected; one used on day 29 is extended, and the refresh cookie is forwarded", async () => {
    const member = await addMember();
    const browser = await signedIn(member);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start + 29 * DAY);
    const day29 = await browser.call("/api/me");
    expect(day29.status).toBe(200);
    // The daily sliding refresh re-issues the cookie through our route (workaround 12).
    expect(day29.headers.getSetCookie().some((c) => c.startsWith("__Host-officebox.session_token="))).toBe(true);
    vi.setSystemTime(start + 29 * DAY + 29 * DAY);
    expect((await browser.call("/api/me")).status).toBe(200);
    // Now unused for 30 days and a bit.
    vi.setSystemTime(start + 58 * DAY + 30 * DAY + 60_000);
    expect((await browser.call("/api/me")).status).toBe(401);
  });

  it("refuses to create a session for a disabled member through any better-auth path", async () => {
    const member = await addMember();
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    const browser = new Browser();
    const before = await sessionsOf(member.id);
    const { verify } = await signInWithPasskey(browser, member.authenticator);
    expect(verify.status).toBeGreaterThanOrEqual(400);
    expect(browser.sessionCookie).toBeUndefined();
    expect(await sessionsOf(member.id)).toBe(before);
  });

  it("a disabled member's existing session fails on its next request (no cookie cache)", async () => {
    const member = await addMember();
    expect((await member.browser.call("/api/me")).status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    expect((await member.browser.call("/api/me")).status).toBe(401);
  });

  it("sign-out (better-auth's route) ends this session, fires the revocation hook and clears the cookie", async () => {
    const member = await addMember();
    const calls: [string, RevocationScope][] = [];
    const stop = onRevocation((userId, _reason, scope) => calls.push([userId, scope]));
    try {
      const out = await member.browser.call("/api/auth/sign-out", { body: {} });
      expect(out.status).toBe(200);
    } finally {
      stop();
    }
    expect(member.browser.sessionCookie).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(member.id);
    expect(await sessionsOf(member.id)).toBe(0);
  });
});

describe("My devices (Identity §4.5)", () => {
  it("lists own sessions with device fields and the current one, never a token", async () => {
    const member = await addMember();
    const second = await signedIn(member);
    const list = await member.browser.json<{ sessions: { id: string; current: boolean; deviceLabel: string }[] }>(
      "/api/me/sessions",
    );
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions.filter((s) => s.current)).toHaveLength(1);
    const text = JSON.stringify(list.body);
    const { results } = await env.DB.prepare("SELECT token FROM sessions WHERE user_id = ?")
      .bind(member.id)
      .all<{ token: string }>();
    for (const { token } of results) expect(text).not.toContain(token);
    expect(text).not.toMatch(/"token"/);
    void second;
  });

  it("signs out one other device; its next request fails at once; another member's session is 404", async () => {
    const member = await addMember();
    const other = await signedIn(member);
    const stranger = await addMember();
    const list = await member.browser.json<{ sessions: { id: string; current: boolean }[] }>("/api/me/sessions");
    const target = list.body.sessions.find((s) => !s.current)!;
    expect((await stranger.browser.json(`/api/me/sessions/${target.id}`, { method: "DELETE" })).status).toBe(404);
    const calls: RevocationScope[] = [];
    const stop = onRevocation((_u, _r, scope) => calls.push(scope));
    try {
      expect((await member.browser.json(`/api/me/sessions/${target.id}`, { method: "DELETE" })).status).toBe(200);
    } finally {
      stop();
    }
    expect(calls).toEqual([{ sessionId: target.id }]);
    expect((await other.call("/api/me")).status).toBe(401);
    expect((await member.browser.call("/api/me")).status).toBe(200);
  });

  it("signs out all other devices", async () => {
    const member = await addMember();
    const a = await signedIn(member);
    const b = await signedIn(member);
    const result = await member.browser.json("/api/me/sessions/sign-out-others", { body: {} });
    expect(result.body).toEqual({ signedOut: 2 });
    expect((await a.call("/api/me")).status).toBe(401);
    expect((await b.call("/api/me")).status).toBe(401);
    expect((await member.browser.call("/api/me")).status).toBe(200);
  });

  it("signs out everywhere, this device included, and clears the cookie", async () => {
    const member = await addMember();
    const other = await signedIn(member);
    const calls: RevocationScope[] = [];
    const stop = onRevocation((_u, _r, scope) => calls.push(scope));
    try {
      expect((await member.browser.json("/api/me/sessions/sign-out-everywhere", { body: {} })).status).toBe(200);
    } finally {
      stop();
    }
    expect(calls).toHaveLength(2);
    expect(member.browser.sessionCookie).toBeUndefined();
    expect((await other.call("/api/me")).status).toBe(401);
    expect(await sessionsOf(member.id)).toBe(0);
  });

  it("needs a session", async () => {
    expect((await new Browser().json("/api/me/sessions")).status).toBe(401);
    expect((await new Browser().json("/api/me/sessions/sign-out-everywhere", { body: {} })).status).toBe(401);
  });
});

describe("step-up re-authentication (Identity §4.5; POST /me/reauth)", () => {
  it("updates fresh_auth_at on the current session without creating another", async () => {
    const member = await addMember();
    await staleFreshAuth(member.id);
    const before = await sessionsOf(member.id);
    const result = await reauth(member.browser, member.authenticator);
    expect(result.status).toBe(200);
    expect(await sessionsOf(member.id)).toBe(before);
    const me = await member.browser.json<{ session: { freshAuthAt: number; freshAuthMethod: string } }>("/api/me");
    expect(me.body.session.freshAuthMethod).toBe("passkey");
    // A step-up is a use of the passkey.
    const used = await env.DB.prepare("SELECT last_used_at FROM passkeys WHERE user_id = ?")
      .bind(member.id)
      .first<{ last_used_at: number }>();
    expect(Date.now() - used!.last_used_at).toBeLessThan(60_000);
    expect(Date.now() - me.body.session.freshAuthAt).toBeLessThan(60_000);
  });

  it("options list the signed-in user's passkeys (better-auth scopes them by session) and require UV", async () => {
    const member = await addMember();
    const options = await member.browser.json<{ allowCredentials: unknown[]; userVerification: string }>(
      "/api/me/reauth/options",
      { body: {} },
    );
    expect(options.body.allowCredentials).toHaveLength(1);
    expect(options.body.userVerification).toBe("required");
  });

  it("another user's passkey can't satisfy it, and leaves no session for them; the failure is audited", async () => {
    const member = await addMember();
    const other = await addMember();
    await staleFreshAuth(member.id);
    const otherSessions = await sessionsOf(other.id);
    const options = await member.browser.json<{ challenge: string }>("/api/me/reauth/options", { body: {} });
    const response = await other.authenticator.authenticate({ challenge: options.body.challenge }, ORIGIN);
    const result = await member.browser.json("/api/me/reauth", { body: { response } });
    expect(result.status).toBe(403);
    expect(await sessionsOf(other.id)).toBe(otherSessions);
    const audited = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE action = 'auth.reauth_failed' AND actor_id = ?",
    )
      .bind(member.id)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
    const me = await member.browser.json<{ session: { freshAuthAt: number } }>("/api/me");
    expect(Date.now() - me.body.session.freshAuthAt).toBeGreaterThan(10 * 60_000);
  });

  it("an assertion without user verification is refused", async () => {
    const member = await addMember();
    await staleFreshAuth(member.id);
    expect((await reauth(member.browser, member.authenticator, { uv: false })).status).toBe(403);
  });

  it("is limited to 5 attempts per 10 minutes per session", async () => {
    const member = await addMember();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (await member.browser.json("/api/me/reauth", { body: { response: { id: "x", type: "public-key" } } })).status,
      );
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("the sliding refresh doesn't change the fresh-auth facts", async () => {
    const member = await addMember();
    await staleFreshAuth(member.id, 20);
    const before = await env.DB.prepare("SELECT fresh_auth_at FROM sessions WHERE user_id = ?")
      .bind(member.id)
      .first<{ fresh_auth_at: number }>();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start + 2 * DAY);
    expect((await member.browser.call("/api/me")).status).toBe(200);
    vi.useRealTimers();
    const after = await env.DB.prepare("SELECT fresh_auth_at FROM sessions WHERE user_id = ?")
      .bind(member.id)
      .first<{ fresh_auth_at: number }>();
    expect(after?.fresh_auth_at).toBe(before?.fresh_auth_at);
  });
});

describe("the security-notice banner (Identity §4.6a)", () => {
  it("can't be acknowledged without a fresh passkey assertion; can be after one", async () => {
    const member = await addMember();
    await reauth(member.browser, member.authenticator);
    // Adding a second passkey raises a notice.
    const { registerPasskey } = await import("./helpers");
    await registerPasskey(member.browser, new SoftAuthenticator());
    const list = await member.browser.json<{ notices: { id: string; kind: string }[] }>("/api/me/security-notices");
    expect(list.body.notices.map((n) => n.kind)).toEqual(["passkey_added"]);
    await staleFreshAuth(member.id);
    const refused = await member.browser.json("/api/me/security-notices/ack", { body: {} });
    expect(refused.body).toMatchObject({ error: { code: "reauth_required" } });
    expect((await member.browser.json<{ notices: unknown[] }>("/api/me/security-notices")).body.notices).toHaveLength(
      1,
    );
    await reauth(member.browser, member.authenticator);
    const acked = await member.browser.json("/api/me/security-notices/ack", {
      body: { ids: [list.body.notices[0]!.id] },
    });
    expect(acked.body).toEqual({ acknowledged: 1 });
    expect((await member.browser.json<{ notices: unknown[] }>("/api/me/security-notices")).body.notices).toHaveLength(
      0,
    );
  });

  it("a fresh passkey sign-in can acknowledge", async () => {
    const member = await addMember();
    const { appendNotice } = await import("../../src/features/identity/notices");
    await appendNotice(env.DB, member.id, "passkey_added", { createdVia: "signed_in" }, Date.now());
    const browser = await signedIn(member);
    expect((await browser.json("/api/me/security-notices/ack", { body: {} })).body).toEqual({ acknowledged: 1 });
  });

  it("GET /me includes the pending notices", async () => {
    const member = await addMember();
    const { appendNotice } = await import("../../src/features/identity/notices");
    await appendNotice(env.DB, member.id, "passkey_clone_detected", {}, Date.now());
    const me = await member.browser.json<{ securityNotices: { kind: string }[] }>("/api/me");
    expect(me.body.securityNotices.map((n) => n.kind)).toEqual(["passkey_clone_detected"]);
  });
});
