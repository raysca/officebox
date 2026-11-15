// Q2 magic links: in-process verify with Set-Cookie, storeToken "hashed", unknown emails under disableSignUp, 900 s.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tokenHash } from "../src/auth";
import { queryLog, setQueryLogging } from "../src/d1-kysely";
import { apiHeaders, createUser, ensureInstallation, ORIGIN, requestMagicLink, signInWithMagicLink, testAuth, uniqueEmail, withStore } from "./helpers";

async function sha256b64url(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return btoa(String.fromCharCode(...d)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("Q2 magic link", () => {
  it("our confirmation POST calls auth.api.magicLinkVerify in-process and forwards its Set-Cookie", async () => {
    const { userId, email } = await createUser();
    const { cookie, setCookie, body } = await signInWithMagicLink(email);
    expect(setCookie).toMatch(/^__Host-officebox\.session_token=/);
    expect(body).toEqual({ ok: true, userId });
    const me = await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const meBody = await me.json<{ id: string; freshAuthMethod: string | null; freshAuthAt: number | null }>();
    expect(meBody.id).toBe(userId);
    expect(meBody.freshAuthMethod).toBe("magic_link");
    expect(meBody.freshAuthAt).toBeNull(); // a magic link never satisfies step-up
  });

  it("returnHeaders gives the Set-Cookie headers; the raw response body carries the session token (so it must be stripped)", async () => {
    const { email } = await createUser();
    const { token } = await requestMagicLink(email);
    const auth = testAuth();
    const out = await withStore(() => auth.api.magicLinkVerify({ query: { token: token! }, headers: new Headers(), returnHeaders: true }));
    const set = out.headers?.getSetCookie() ?? [];
    expect(set.some((c) => c.startsWith("__Host-officebox.session_token="))).toBe(true);
    const r = out.response as { token: string; session: { token: string } };
    expect(typeof r.token).toBe("string");
    expect(r.session.token).toBe(r.token);
  });

  it('storeToken: "hashed" stores SHA-256(token) as the verification identifier, never the token', async () => {
    const { email } = await createUser();
    const { token } = await requestMagicLink(email);
    const ids = await env.DB.prepare("SELECT identifier, value, expires_at, created_at FROM auth_verifications WHERE value LIKE ?")
      .bind(`%${email}%`)
      .all<{ identifier: string; value: string; expires_at: number; created_at: number }>();
    expect(ids.results).toHaveLength(1);
    const row = ids.results[0]!;
    expect(row.identifier).toBe(`magic-link:${await sha256b64url(token!)}`);
    expect(row.identifier).not.toContain(token!);
    // expiresIn: 900 is honoured, and dates are integers (epoch ms)
    expect(typeof row.expires_at).toBe("number");
    expect(row.expires_at - row.created_at).toBeGreaterThanOrEqual(899_000);
    expect(row.expires_at - row.created_at).toBeLessThanOrEqual(901_000);
    // our own row is an HMAC with TOKEN_HASH_KEY
    const ours = await env.DB.prepare("SELECT user_id FROM magic_link_issues WHERE token_hash = ?").bind(await tokenHash(env.TOKEN_HASH_KEY, token!)).first();
    expect(ours).not.toBeNull();
  });

  it("a token is single-use; five concurrent confirmation POSTs sign in exactly once", async () => {
    const { email } = await createUser();
    const { token } = await requestMagicLink(email);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => SELF.fetch(`${ORIGIN}/api/sign-in/link`, { method: "POST", headers: apiHeaders(), body: JSON.stringify({ token }) })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400, 400]);
  });

  it("better-auth's own consume is atomic too: five concurrent in-process verifies create one session", async () => {
    const { userId, email } = await createUser();
    const { token } = await requestMagicLink(email);
    const auth = testAuth();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => withStore(() => auth.api.magicLinkVerify({ query: { token: token! }, headers: new Headers() }))),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?").bind(userId).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("an expired link (past 900 s) is refused", async () => {
    const { email } = await createUser();
    const { token } = await requestMagicLink(email);
    await env.DB.prepare("UPDATE auth_verifications SET expires_at = ? WHERE value LIKE ?").bind(Date.now() - 1, `%${email}%`).run();
    const auth = testAuth();
    await expect(withStore(() => auth.api.magicLinkVerify({ query: { token: token! }, headers: new Headers() }))).rejects.toMatchObject({ status: "FOUND" });
  });

  it("disableSignUp: the request route still calls sendMagicLink for an unknown email, with the same response", async () => {
    await ensureInstallation();
    const known = (await createUser()).email;
    const unknown = uniqueEmail("nobody");
    const a = await requestMagicLink(known);
    const b = await requestMagicLink(unknown);
    expect(a.res.status).toBe(b.res.status);
    expect(await a.res.text()).toBe(await b.res.text());
    expect([...a.res.headers.keys()].sort()).toEqual([...b.res.headers.keys()].sort());
    // sendMagicLink ran for the unknown address: our row exists (user_id NULL), and no mail was captured
    const row = await env.DB.prepare("SELECT user_id FROM magic_link_issues WHERE email_normalised = ?").bind(unknown).first<{ user_id: string | null }>();
    expect(row).toEqual({ user_id: null });
    expect(b.token).toBeNull();
    // better-auth wrote a verification row for it too (it never looks the address up on request)
    const v = await env.DB.prepare("SELECT count(*) AS n FROM auth_verifications WHERE value LIKE ?").bind(`%${unknown}%`).first<{ n: number }>();
    expect(v?.n).toBe(1);
  });

  it("the same SQL runs for a known and an unknown email (better-auth's side), so the work is identical", async () => {
    const known = (await createUser()).email;
    const auth = testAuth();
    // The first call on a new instance also runs better-auth's schema check (two introspection queries); warm it up.
    await withStore(() => auth.api.signInMagicLink({ body: { email: uniqueEmail("warmup") }, headers: new Headers() }));
    const run = async (email: string) => {
      setQueryLogging(true);
      await withStore(() => auth.api.signInMagicLink({ body: { email }, headers: new Headers() }));
      const shape = queryLog.map((q) => q.sql);
      setQueryLogging(false);
      return shape;
    };
    const k = await run(known);
    const u = await run(uniqueEmail("nobody"));
    expect(k.length).toBeGreaterThan(0);
    expect(u).toEqual(k);
  });

  it("disableSignUp: verifying an unknown email's token creates no user and no session", async () => {
    await ensureInstallation();
    const unknown = uniqueEmail("nobody");
    const auth = testAuth();
    let token = "";
    await withStore(() =>
      auth.api.signInMagicLink({ body: { email: unknown }, headers: new Headers() }).then(async () => {
        const row = await env.DB.prepare("SELECT token_hash FROM magic_link_issues WHERE email_normalised = ?").bind(unknown).first();
        expect(row).not.toBeNull();
      }),
    );
    // Our confirmation POST refuses first (no eligible user). Call better-auth directly to show its own behaviour:
    const issued = await withStore(async () => {
      // generate a fresh token through the API and capture it from the verification row is impossible (hashed), so mint one:
      const ctx = await auth.$context;
      token = "unknown-" + crypto.randomUUID();
      await ctx.internalAdapter.createVerificationValue({
        identifier: `magic-link:${await sha256b64url(token)}`,
        value: JSON.stringify({ type: "magic-link", email: unknown }),
        expiresAt: new Date(Date.now() + 60_000),
      });
      return auth.api.magicLinkVerify({ query: { token }, headers: new Headers() }).catch((e: { status: string; headers?: Headers }) => e);
    });
    expect((issued as { status: string }).status).toBe("FOUND");
    expect(String((issued as { headers: Headers }).headers.get("location"))).toContain("new_user_signup_disabled");
    const u = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email = ?").bind(unknown).first<{ n: number }>();
    expect(u?.n).toBe(0);
  });
});
