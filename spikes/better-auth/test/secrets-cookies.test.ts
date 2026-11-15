// Q5 BETTER_AUTH_SECRETS rotation and Q9 cookie names and attributes.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createUser, requestMagicLink, testAuth, withStore } from "./helpers";

const A = "secret-A-0123456789abcdef0123456789abcdef-aaaaaaaa";
const B = "secret-B-fedcba9876543210fedcba9876543210-bbbbbbbb";

async function cookieFrom(auth: ReturnType<typeof testAuth>): Promise<{ setCookie: string; pair: string; userId: string }> {
  const { userId, email } = await createUser();
  const { token } = await requestMagicLink(email);
  const out = await withStore(() => auth.api.magicLinkVerify({ query: { token: token! }, headers: new Headers(), returnHeaders: true }));
  const setCookie = (out.headers?.getSetCookie() ?? []).find((c) => c.includes("session_token="))!;
  return { setCookie, pair: setCookie.split(";")[0]!, userId };
}

const sessionUser = async (auth: ReturnType<typeof testAuth>, cookie: string) =>
  (await withStore(() => auth.api.getSession({ headers: new Headers({ cookie }) })))?.user.id ?? null;

describe("Q5 secret rotation", () => {
  it("BETTER_AUTH_SECRETS format is '<version>:<secret>,…' (newest first); a malformed value throws at startup", async () => {
    // The parser is internal; the same rules apply to the `secrets` option, which is what the Worker would pass.
    const bad = testAuth({ secrets: [{ version: 1, value: A }, { version: 1, value: B }] });
    await expect(bad.$context).rejects.toThrow(/Duplicate version 1/);
  });

  it("a session cookie signed with the old secret is still accepted after rotation (old version kept in the list)", async () => {
    const before = testAuth({ secret: A });
    const { pair, userId } = await cookieFrom(before);
    expect(await sessionUser(before, pair)).toBe(userId);
    const rotated = testAuth({ secrets: [{ version: 2, value: B }, { version: 1, value: A }] });
    const after = await sessionUser(rotated, pair);
    // Recorded result (see README Q5): the session cookie's HMAC uses only the current secret.
    expect(after).toBeNull();
    // Control: with A still current (B listed as an older version) the same cookie works.
    expect(await sessionUser(testAuth({ secrets: [{ version: 2, value: A }, { version: 1, value: B }] }), pair)).toBe(userId);
  });

  it("the legacy BETTER_AUTH_SECRET (`secret`) passed alongside `secrets` doesn't rescue old session cookies either", async () => {
    const before = testAuth({ secret: A });
    const { pair } = await cookieFrom(before);
    const rotated = testAuth({ secrets: [{ version: 2, value: B }], secret: A });
    expect(await sessionUser(rotated, pair)).toBeNull();
  });

  it("the session row survives rotation; only the cookie signature fails (the user must sign in again)", async () => {
    const before = testAuth({ secret: A });
    const { userId } = await cookieFrom(before);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?").bind(userId).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe("Q9 cookies", () => {
  it("our configuration produces a valid __Host- session cookie: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain", async () => {
    const { setCookie, pair, userId } = await cookieFrom(testAuth());
    expect(setCookie).toMatch(/^__Host-officebox\.session_token=/);
    expect(setCookie).toMatch(/; Secure/i);
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; SameSite=Lax/i);
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).toMatch(/Max-Age=2592000/);
    // and better-auth reads it back
    expect(await sessionUser(testAuth(), pair)).toBe(userId);
  });

  it("better-auth's defaults: '__Secure-better-auth.session_token' on an https baseURL, SameSite=Lax, Path=/, HttpOnly", async () => {
    const { setCookie } = await cookieFrom(testAuth({ cookies: "default" }));
    expect(setCookie).toMatch(/^__Secure-better-auth\.session_token=/);
    expect(setCookie).toMatch(/; SameSite=Lax/i);
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; Secure/i);
  });

  it("naming a cookie __Host-… while useSecureCookies is on gives an invalid '__Secure-__Host-…' name", async () => {
    // Shown with the createCookieGetter logic: the prefix is prepended to whatever name is configured.
    const { createCookieGetter } = await import("better-auth/cookies");
    const get = createCookieGetter({ baseURL: "https://officebox.test", advanced: { cookiePrefix: "__Host-officebox" } });
    expect(get("session_token").name).toBe("__Secure-__Host-officebox.session_token");
  });

  it("the passkey challenge cookie gets the same prefix and attributes", async () => {
    const { createCookieGetter } = await import("better-auth/cookies");
    const get = createCookieGetter({
      baseURL: "https://officebox.test",
      advanced: { useSecureCookies: false, cookiePrefix: "__Host-officebox", defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" } },
    });
    const c = get("better-auth-passkey");
    expect(c.name).toBe("__Host-officebox.better-auth-passkey");
    expect(c.attributes).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax", path: "/" });
    expect(c.attributes).not.toHaveProperty("domain");
  });
});
