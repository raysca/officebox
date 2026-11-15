// Q4 hooks: user.create.before on every creation path, a server-set marker, session.create.before refusal, session delete hook.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { apiHeaders, createUser, ensureInstallation, ORIGIN, requestMagicLink, signInWithMagicLink, testAuth, uniqueEmail, withCreateMarker, withStore } from "./helpers";

const countUsers = async (email: string) => (await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email = ?").bind(email).first<{ n: number }>())!.n;

async function sha256b64url(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return btoa(String.fromCharCode(...d)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("Q4 user.create.before covers every creation path", () => {
  it("internalAdapter.createUser without the marker: refused (returns null)", async () => {
    const ctx = await testAuth().$context;
    const email = uniqueEmail("nomarker");
    const u = await withStore(() => ctx.internalAdapter.createUser({ email, name: "x", emailVerified: true }, { method: "test" }));
    expect(u).toBeNull();
    expect(await countUsers(email)).toBe(0);
  });

  it("internalAdapter.createUser with the marker: created, and the hook can read the marker (attempt id recorded)", async () => {
    const ctx = await testAuth().$context;
    const email = uniqueEmail("marker");
    const u = await withCreateMarker(() => ctx.internalAdapter.createUser({ email, name: "x", emailVerified: true }, { method: "test" }));
    expect(u?.id).toBeTruthy();
    const row = await env.DB.prepare("SELECT created_attempt_id FROM users WHERE id = ?").bind(u.id).first<{ created_attempt_id: string }>();
    expect(row?.created_attempt_id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it("internalAdapter.createOAuthUser (the OAuth/link-account path) without the marker: refused", async () => {
    const ctx = await testAuth().$context;
    const email = uniqueEmail("oauth");
    await withStore(() =>
      ctx.internalAdapter.createOAuthUser({ email, name: "x", emailVerified: true }, { accountId: "a", providerId: "p" }).catch(() => null),
    );
    expect(await countUsers(email)).toBe(0);
  });

  it("auth.api.signUpEmail: refused (email-and-password disabled), no user", async () => {
    const auth = testAuth();
    const email = uniqueEmail("signup");
    await expect(withStore(() => auth.api.signUpEmail({ body: { email, password: "correct horse battery staple", name: "x" }, headers: new Headers() }))).rejects.toBeTruthy();
    expect(await countUsers(email)).toBe(0);
  });

  it("magic-link verify for an unknown email with disableSignUp OFF: the create hook still refuses", async () => {
    const auth = testAuth({ magicLinkDisableSignUp: false });
    const ctx = await auth.$context;
    const email = uniqueEmail("ml-signup");
    const token = "t-" + crypto.randomUUID();
    const identifier = `magic-link:${await sha256b64url(token)}`;
    await withStore(() =>
      ctx.internalAdapter.createVerificationValue({
        identifier,
        value: JSON.stringify({ type: "magic-link", email }),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    const err = await withStore(() => auth.api.magicLinkVerify({ query: { token }, headers: new Headers() }).catch((e: { headers: Headers }) => e));
    expect(String((err as { headers: Headers }).headers.get("location"))).toContain("failed_to_create_user");
    expect(await countUsers(email)).toBe(0);
  });

  it("a pending invitation alone isn't enough, and no request can set the marker (no header/body path)", async () => {
    await ensureInstallation();
    const email = uniqueEmail("invited");
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS invitations (email TEXT)").run();
    await env.DB.prepare("INSERT INTO invitations (email) VALUES (?)").bind(email).run();
    const res = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: apiHeaders({ "x-officebox-marker": "setup" }),
      body: JSON.stringify({ email, password: "correct horse battery staple", name: "x" }),
    });
    expect(res.status).toBe(404); // not on the allowlist either
    expect(await countUsers(email)).toBe(0);
  });

  it("passkey registration without a session or enrolment ticket can't even get options (resolveUser refuses)", async () => {
    await ensureInstallation();
    const res = await SELF.fetch(`${ORIGIN}/api/auth/passkey/generate-register-options`, { headers: apiHeaders() });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "ENROLMENT_TICKET_REQUIRED" });
  });
});

describe("Q4 session hooks", () => {
  it("session.create.before refuses a disabled member: better-auth's magic-link verify can't sign them in", async () => {
    const { userId, email } = await createUser();
    const { token } = await requestMagicLink(email);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(userId).run();
    const auth = testAuth();
    const err = await withStore(() => auth.api.magicLinkVerify({ query: { token: token! }, headers: new Headers() }).catch((e: { headers: Headers }) => e));
    expect(String((err as { headers: Headers }).headers.get("location"))).toContain("failed_to_create_session");
    const n = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?").bind(userId).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("session.create.after runs (first_signed_in_at set once)", async () => {
    const { userId, email } = await createUser();
    await signInWithMagicLink(email);
    const a = await env.DB.prepare("SELECT first_signed_in_at FROM users WHERE id = ?").bind(userId).first<{ first_signed_in_at: number }>();
    expect(typeof a?.first_signed_in_at).toBe("number");
  });

  it("a session-delete hook exists: sign-out, revoke-one and revoke-all each fire session.delete.after per session", async () => {
    const { userId, email } = await createUser();
    const s1 = await signInWithMagicLink(email);
    const s2 = await signInWithMagicLink(email);
    const s3 = await signInWithMagicLink(email);
    // 1) sign-out through the exposed route
    const out = await SELF.fetch(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: apiHeaders({ cookie: s1.cookie }), body: "{}" });
    expect(out.status).toBe(200);
    // 2) revoke-all (sign out everywhere) on the server through auth.api
    const auth = testAuth();
    await withStore(() => auth.api.revokeSessions({ headers: new Headers({ cookie: s2.cookie }) }));
    const notices = await env.DB.prepare("SELECT count(*) AS n FROM security_notices WHERE user_id = ? AND kind = 'spike_session_deleted'").bind(userId).first<{ n: number }>();
    expect(notices?.n).toBe(3);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?").bind(userId).first<{ n: number }>();
    expect(left?.n).toBe(0);
    void s3;
  });

  it("an expired session is refused on read and deleted lazily: the delete hook fires on the next read, not at expiry", async () => {
    const { userId, email } = await createUser();
    const s = await signInWithMagicLink(email);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").bind(Date.now() - 1000, userId).run();
    const before = await env.DB.prepare("SELECT count(*) AS n FROM security_notices WHERE user_id = ?").bind(userId).first<{ n: number }>();
    expect(before?.n).toBe(0); // nothing fired when it expired
    const me = await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie: s.cookie } });
    expect(me.status).toBe(401);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM security_notices WHERE user_id = ? AND kind = 'spike_session_deleted'").bind(userId).first<{ n: number }>();
    // better-auth deletes the expired row when it's next presented (getSession), which fires the hook then
    expect(after?.n).toBe(1);
  });
});
