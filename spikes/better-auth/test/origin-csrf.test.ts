// Q6 origin and CSRF: our X-Officebox-Request + same-origin middleware beside better-auth's origin check; the allowlist;
// trustedOrigins / baseURL / rpID from the installation record, one instance per origin.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authFor, clearInstances, instancesBuilt } from "../src/auth";
import { apiHeaders, createUser, ensureInstallation, ORIGIN, signInWithMagicLink, testAuth, uniqueEmail, withStore } from "./helpers";

const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

describe("Q6 CSRF: our middleware and better-auth's origin check", () => {
  it("state-changing requests without X-Officebox-Request, or with another Origin, are refused before better-auth runs", async () => {
    await ensureInstallation();
    const body = { email: uniqueEmail() };
    const noHeader = await post("/api/auth/sign-in/magic-link", { "content-type": "application/json", origin: ORIGIN }, body);
    expect(noHeader.status).toBe(403);
    const evil = await post("/api/auth/sign-in/magic-link", apiHeaders({ origin: "https://attacker.test" }), body);
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({ error: "csrf" });
    const ok = await post("/api/auth/sign-in/magic-link", apiHeaders(), body);
    expect(ok.status).toBe(200);
  });

  it("with a session cookie, the correct header and the canonical Origin, better-auth's own check passes too (they coexist)", async () => {
    const { email } = await createUser();
    const { cookie } = await signInWithMagicLink(email);
    const res = await post("/api/auth/sign-out", apiHeaders({ cookie }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("better-auth's check alone (handler called directly, bypassing our middleware) refuses a foreign Origin when a cookie is present", async () => {
    const { email } = await createUser();
    const { cookie } = await signInWithMagicLink(email);
    const auth = testAuth();
    const res = await withStore(() =>
      auth.handler(new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { cookie, origin: "https://attacker.test", "content-type": "application/json" }, body: "{}" })),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "INVALID_ORIGIN" });
  });

  it("…but without a cookie better-auth skips its Origin check on most routes (so our middleware is the real CSRF control)", async () => {
    await ensureInstallation();
    const auth = testAuth();
    const res = await withStore(() =>
      auth.handler(
        new Request(`${ORIGIN}/api/auth/passkey/verify-authentication`, {
          method: "POST",
          headers: { origin: "https://attacker.test", "content-type": "application/json" },
          body: JSON.stringify({ response: { id: "x" } }),
        }),
      ),
    );
    // Not INVALID_ORIGIN: it got as far as looking for the challenge cookie.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
  });

  it("the options GETs have side effects (challenge cookie + verification row), so our middleware requires the header on them too", async () => {
    await ensureInstallation();
    const bare = await SELF.fetch(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`);
    expect(bare.status).toBe(403);
    const ok = await SELF.fetch(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, { headers: apiHeaders() });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^__Host-officebox\.better-auth-passkey=/);
  });
});

describe("Q6 allowlist: default-deny on the exact normalised method and path", () => {
  const denied: [string, string][] = [
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/sign-in/email"],
    ["GET", "/api/auth/magic-link/verify?token=x"],
    ["GET", "/api/auth/list-sessions"],
    ["POST", "/api/auth/revoke-sessions"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/delete-user"],
    ["POST", "/api/auth/change-email"],
    ["GET", "/api/auth/passkey/list-user-passkeys"],
    ["POST", "/api/auth/passkey/delete-passkey"],
    ["POST", "/api/auth//sign-out"],
    ["POST", "/api/auth/sign-out/"],
    ["POST", "/api/auth/SIGN-OUT"],
    ["POST", "/api/auth/%73ign-out"],
    ["POST", "/api/auth/x/%2e%2e/passkey/delete-passkey"],
    ["POST", "/api/auth/passkey%2fdelete-passkey"],
    ["HEAD", "/api/auth/passkey/generate-authenticate-options"],
    ["OPTIONS", "/api/auth/sign-out"],
    ["GET", "/api/auth/sign-out"],
  ];
  it.each(denied)("%s %s → 404", async (method, path) => {
    await ensureInstallation();
    const res = await SELF.fetch(`${ORIGIN}${path}`, { method, headers: apiHeaders(), body: method === "GET" || method === "HEAD" ? undefined : "{}" });
    expect(res.status === 404 || (method !== "GET" && method !== "HEAD" && res.status === 403)).toBe(true);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

it("a %2e%2e segment is resolved by the URL parser before the Worker sees it (so it can't smuggle a path)", () => {
  expect(new URL(`${ORIGIN}/api/auth/x/%2e%2e/sign-out`).pathname).toBe("/api/auth/sign-out");
});

describe("Q6 per-installation origin, rpID and baseURL", () => {
  it("rpID, rpName and the trusted origin come from the installation record; another origin's instance refuses it", async () => {
    const a = testAuth({}, { workspaceName: "Alpha", canonicalOrigin: "https://alpha.officebox.test" });
    const b = testAuth({}, { workspaceName: "Beta", canonicalOrigin: "https://beta.officebox.test:8443" });
    const optsA = await withStore(() => a.api.generatePasskeyAuthenticationOptions({ headers: new Headers() }));
    const optsB = await withStore(() => b.api.generatePasskeyAuthenticationOptions({ headers: new Headers() }));
    expect(optsA.rpId).toBe("alpha.officebox.test");
    expect(optsB.rpId).toBe("beta.officebox.test");
    expect((await a.$context).baseURL).toBe("https://alpha.officebox.test/api/auth");
    expect((await b.$context).trustedOrigins).toContain("https://beta.officebox.test:8443");
    expect((await b.$context).trustedOrigins).not.toContain("https://alpha.officebox.test");
  });

  it("the Worker builds one instance per installation origin and rebuilds only when the record changes", async () => {
    clearInstances();
    const base = instancesBuilt;
    const inst = { workspaceName: "Gamma", canonicalOrigin: "https://gamma.officebox.test" };
    const first = authFor(env, inst);
    expect(authFor(env, inst)).toBe(first);
    expect(instancesBuilt).toBe(base + 1);
    const moved = authFor(env, { ...inst, canonicalOrigin: "https://delta.officebox.test" });
    expect(moved).not.toBe(first);
    expect(instancesBuilt).toBe(base + 2);
    // A pending domain move: a second instance for the pending origin can coexist, used only by the completion routes.
    expect(authFor(env, inst)).toBe(first);
  });

  it("requests on a host that isn't the canonical origin are refused by our middleware", async () => {
    await ensureInstallation();
    const res = await SELF.fetch("https://other.officebox.test/api/me");
    expect(res.status).toBe(421);
  });
});
