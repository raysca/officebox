// Q7 token exposure: which better-auth responses carry the session token, and proof the Hono filter strips it.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { stripTokens } from "../src/app";
import { apiHeaders, createUser, ensureInstallation, ORIGIN, requestMagicLink, signInWithMagicLink, testAuth, uniqueEmail, withStore } from "./helpers";

const tokenOf = async (userId: string) =>
  (await env.DB.prepare("SELECT token FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(userId).first<{ token: string }>())!.token;

describe("Q7 which better-auth responses contain the session token (raw, unfiltered)", () => {
  it("magic-link verify (no callbackURL): top-level token and session.token", async () => {
    const { userId, email } = await createUser();
    const { token } = await requestMagicLink(email);
    const r = await withStore(() => testAuth().api.magicLinkVerify({ query: { token: token! }, headers: new Headers() }));
    const t = await tokenOf(userId);
    expect(JSON.stringify(r)).toContain(t);
  });

  it("get-session, list-sessions: session.token / each session's token", async () => {
    const { userId, email } = await createUser();
    const { cookie } = await signInWithMagicLink(email);
    const t = await tokenOf(userId);
    const auth = testAuth();
    const gs = await withStore(() => auth.api.getSession({ headers: new Headers({ cookie }) }));
    expect(JSON.stringify(gs)).toContain(t);
    const ls = await withStore(() => auth.api.listSessions({ headers: new Headers({ cookie }) }));
    expect(JSON.stringify(ls)).toContain(t);
  });

  it("sign-out and the magic-link request don't", async () => {
    const { userId, email } = await createUser();
    const { cookie } = await signInWithMagicLink(email);
    const t = await tokenOf(userId);
    const auth = testAuth();
    const ml = await withStore(() => auth.api.signInMagicLink({ body: { email: uniqueEmail() }, headers: new Headers() }));
    expect(JSON.stringify(ml)).not.toContain(t);
    const so = await withStore(() => auth.api.signOut({ headers: new Headers({ cookie }) }));
    expect(JSON.stringify(so)).not.toContain(t);
  });
});

describe("Q7 the filter", () => {
  it("stripTokens removes every `token` key and any string equal to a session token, at any depth", () => {
    const t = "SESSIONTOKEN123";
    const body = { token: t, session: { id: "s", token: t, nested: [{ token: "x" }, { other: t, keep: "ok" }] }, user: { id: "u" } };
    const out = stripTokens(body, new Set([t]));
    expect(JSON.stringify(out)).not.toContain(t);
    expect(out).toEqual({ session: { id: "s", nested: [{}, { keep: "ok" }] }, user: { id: "u" } });
  });

  it("no response body from our routes or the exposed better-auth routes contains the session token", async () => {
    await ensureInstallation();
    const { userId, email } = await createUser();
    const bodies: string[] = [];
    // magic-link request + our confirm POST (better-auth's raw verify body carries the token: see above)
    const req = await SELF.fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, { method: "POST", headers: apiHeaders(), body: JSON.stringify({ email }) });
    bodies.push(await req.text());
    const row = await env.DB.prepare("SELECT token FROM spike_outbox WHERE email = ? ORDER BY id DESC LIMIT 1").bind(email).first<{ token: string }>();
    const confirm = await SELF.fetch(`${ORIGIN}/api/sign-in/link`, { method: "POST", headers: apiHeaders(), body: JSON.stringify({ token: row!.token }) });
    bodies.push(await confirm.text());
    const cookie = (confirm.headers.get("set-cookie") ?? "").split(";")[0]!;
    const t = await tokenOf(userId);
    expect(cookie).toContain(t); // the cookie is the only place it travels
    for (const path of ["/api/me", "/api/auth/passkey/generate-authenticate-options", "/api/auth/passkey/generate-register-options"]) {
      const r = await SELF.fetch(`${ORIGIN}${path}`, { headers: apiHeaders({ cookie }) });
      bodies.push(await r.text());
    }
    const opts = await SELF.fetch(`${ORIGIN}/api/me/reauth/options`, { method: "POST", headers: apiHeaders({ cookie }), body: "{}" });
    bodies.push(await opts.text());
    const so = await SELF.fetch(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: apiHeaders({ cookie }), body: "{}" });
    bodies.push(await so.text());
    expect(bodies.length).toBe(7);
    for (const b of bodies) expect(b).not.toContain(t);
  });
});
