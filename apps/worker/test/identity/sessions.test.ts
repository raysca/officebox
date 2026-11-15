import { deviceSessionListSchema } from "@officebox/shared";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ACCESS_TOKEN_TTL_MS } from "../../src/features/identity/access-token";
import { AUTH_CACHE_TTL_MS, clearSessionCache, REFRESH_GRACE_MS } from "../../src/features/identity/sessions";
import {
  Clock,
  CookieJar,
  createUser,
  ensureInstalled,
  errorCode,
  FIREFOX_WINDOWS,
  makeApp,
  signIn,
  type TestUser,
} from "./helpers";

/**
 * Sessions (Identity §4.5, §9 "Sessions", tested with an injected clock; TDD §3.1, §8.1): refresh
 * rotation with the grace window and reuse detection, sliding expiry, session_epoch, sign out,
 * sign out everywhere and My devices.
 */

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await ensureInstalled();
});

type Call = ReturnType<typeof makeApp>["call"];

const me = (call: Call, jar: CookieJar) => call("GET", "/api/me", undefined, { jar });
const refresh = (call: Call, jar: CookieJar) => call("POST", "/api/auth/refresh", undefined, { jar });

async function sessionRow(id: string) {
  return env.DB.prepare("SELECT revoked_at, expires_at, last_seen_at FROM sessions WHERE id = ?")
    .bind(id)
    .first<{ revoked_at: number | null; expires_at: number; last_seen_at: number }>();
}

function sessionIdOf(jar: CookieJar): string {
  return (jar.get("ob_refresh") ?? "").split(".")[0] ?? "";
}

async function setup(clock = new Clock()): Promise<{ call: Call; clock: Clock; user: TestUser; jar: CookieJar }> {
  const { call } = makeApp(clock);
  const user = await createUser();
  const jar = await signIn(call, user);
  return { call, clock, user, jar };
}

describe("authenticated requests", () => {
  it("need a session cookie", async () => {
    const { call } = makeApp();
    const res = await call("GET", "/api/me");
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthenticated");
  });

  it("refuse a forged or tampered access token", async () => {
    const { call, jar } = await setup();
    const token = jar.get("ob_session") ?? "";
    const [body = "", signature = ""] = token.split(".");
    const tampered = new CookieJar();
    tampered.values.set("ob_session", `${body}x.${signature}`);
    expect((await me(call, tampered)).status).toBe(401);
    const forged = new CookieJar();
    forged.values.set("ob_session", `${body}.${signature.slice(0, -2)}AA`);
    expect((await me(call, forged)).status).toBe(401);
  });

  it("the access token lasts 15 minutes; a refresh issues a new one", async () => {
    const { call, clock, jar } = await setup();
    clock.advance(ACCESS_TOKEN_TTL_MS + 1);
    expect((await me(call, jar)).status).toBe(401);
    expect((await refresh(call, jar)).status).toBe(200);
    expect((await me(call, jar)).status).toBe(200);
  });
});

describe("refresh rotation and reuse detection", () => {
  it("rotates the refresh token on every refresh", async () => {
    const { call, jar } = await setup();
    const first = jar.get("ob_refresh");
    expect((await refresh(call, jar)).status).toBe(200);
    const second = jar.get("ob_refresh");
    expect(second).not.toBe(first);
    expect(second?.split(".")[0]).toBe(first?.split(".")[0]); // same session
    expect((await refresh(call, jar)).status).toBe(200);
    expect(jar.get("ob_refresh")).not.toBe(second);
  });

  it("two tabs refreshing with the same token within 30 s both get the same successor", async () => {
    const { call, clock, jar } = await setup();
    const tabA = jar.clone();
    const tabB = jar.clone();
    const [a, b] = await Promise.all([refresh(call, tabA), refresh(call, tabB)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(tabA.get("ob_refresh")).toBe(tabB.get("ob_refresh"));

    // A third tab, late but within the grace window, gets it too; nobody is signed out.
    clock.advance(REFRESH_GRACE_MS);
    const tabC = jar.clone();
    expect((await refresh(call, tabC)).status).toBe(200);
    expect(tabC.get("ob_refresh")).toBe(tabA.get("ob_refresh"));
    expect((await me(call, tabA)).status).toBe(200);
    expect((await refresh(call, tabA)).status).toBe(200);
  });

  it("reusing a token after the grace window revokes the session and is audited", async () => {
    const { call, clock, jar, user } = await setup();
    const stolen = jar.clone();
    expect((await refresh(call, jar)).status).toBe(200);
    clock.advance(REFRESH_GRACE_MS + 1);

    const reuse = await refresh(call, stolen);
    expect(reuse.status).toBe(401);
    expect(
      reuse.headers.getSetCookie().some((c) => c.startsWith("ob_refresh=;") || /ob_refresh=.*Max-Age=0/.test(c)),
    ).toBe(true);
    const sessionId = sessionIdOf(jar);
    expect((await sessionRow(sessionId))?.revoked_at).toBe(clock.value);

    // The legitimate holder is signed out too: the whole session is gone.
    expect((await me(call, jar)).status).toBe(401);
    expect((await refresh(call, jar)).status).toBe(401);

    const audit = await env.DB.prepare(
      "SELECT actor_id, metadata FROM audit_log WHERE action = 'session.refresh_reuse' AND target_id = ?",
    )
      .bind(sessionId)
      .first();
    expect(audit).toEqual({ actor_id: null, metadata: JSON.stringify({ userId: user.id }) });
  });

  it("a token two rotations old is reuse even inside the grace window", async () => {
    const { call, jar } = await setup();
    const old = jar.clone();
    await refresh(call, jar);
    await refresh(call, jar);
    expect((await refresh(call, old)).status).toBe(401);
    expect((await me(call, jar)).status).toBe(401);
  });

  it("a garbled cookie is refused without revoking anything", async () => {
    const { call, jar } = await setup();
    const bad = new CookieJar();
    bad.values.set("ob_refresh", "not-a-token");
    expect((await refresh(call, bad)).status).toBe(401);
    expect((await refresh(call, new CookieJar())).status).toBe(401);
    expect((await me(call, jar)).status).toBe(200);
  });

  it("needs the CSRF header", async () => {
    const { call, jar } = await setup();
    const res = await call("POST", "/api/auth/refresh", undefined, { jar, csrf: false });
    expect(await errorCode(res)).toBe("csrf_failed");
  });
});

describe("30-day sliding expiry", () => {
  it("a session unused for 30 days is rejected", async () => {
    const { call, clock, jar } = await setup();
    clock.advance(30 * DAY);
    expect((await refresh(call, jar)).status).toBe(401);
  });

  it("one used on day 29 is extended by another 30 days", async () => {
    const { call, clock, jar } = await setup();
    clock.advance(29 * DAY);
    expect((await refresh(call, jar)).status).toBe(200);
    expect((await sessionRow(sessionIdOf(jar)))?.expires_at).toBe(clock.value + 30 * DAY);
    clock.advance(29 * DAY);
    expect((await refresh(call, jar)).status).toBe(200);
    expect((await me(call, jar)).status).toBe(200);
  });
});

describe("session_epoch and user status", () => {
  it("bumping the epoch revokes every session (REST included)", async () => {
    const { call, jar, user } = await setup();
    expect((await me(call, jar)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?").bind(user.id).run();
    clearSessionCache(env.DB);
    expect((await me(call, jar)).status).toBe(401);
    expect((await refresh(call, jar)).status).toBe(401);
  });

  it("the per-request check is cached for at most 60 seconds", async () => {
    const { call, clock, jar, user } = await setup();
    // /api/me/sessions relies on the middleware's check alone (GET /api/me also re-reads the user).
    const devices = () => call("GET", "/api/me/sessions", undefined, { jar });
    expect((await devices()).status).toBe(200);
    // Disabled in another isolate (no cache invalidation here).
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(user.id).run();
    clock.advance(AUTH_CACHE_TTL_MS - 1);
    expect((await devices()).status).toBe(200);
    clock.advance(1);
    expect((await devices()).status).toBe(401);
    expect((await refresh(call, jar)).status).toBe(401);
  });
});

describe("sign out", () => {
  it("signs out this session: cookies cleared, refresh refused", async () => {
    const { call, jar } = await setup();
    const kept = jar.clone();
    const res = await call("POST", "/api/auth/sign-out", undefined, { jar });
    expect(res.status).toBe(200);
    expect(jar.get("ob_session")).toBeUndefined();
    expect(jar.get("ob_refresh")).toBeUndefined();
    expect((await me(call, kept)).status).toBe(401);
    expect((await refresh(call, kept)).status).toBe(401);
  });

  it("works with only the refresh cookie once the access token has expired", async () => {
    const { call, clock, jar } = await setup();
    clock.advance(ACCESS_TOKEN_TTL_MS + 1);
    const refreshOnly = new CookieJar();
    refreshOnly.values.set("ob_refresh", jar.get("ob_refresh") ?? "");
    expect((await call("POST", "/api/auth/sign-out", undefined, { jar: refreshOnly })).status).toBe(200);
    expect((await sessionRow(sessionIdOf(jar)))?.revoked_at).not.toBeNull();
  });

  it("a forged refresh cookie can't sign someone else out", async () => {
    const { call, jar } = await setup();
    const forged = new CookieJar();
    forged.values.set("ob_refresh", `${sessionIdOf(jar)}.${"A".repeat(43)}`);
    expect((await call("POST", "/api/auth/sign-out", undefined, { jar: forged })).status).toBe(200);
    expect((await sessionRow(sessionIdOf(jar)))?.revoked_at).toBeNull();
    expect((await me(call, jar)).status).toBe(200);
  });

  it("sign out everywhere ends every session, this one included, and is audited", async () => {
    const clock = new Clock();
    const { call } = makeApp(clock);
    const user = await createUser();
    const laptop = await signIn(call, user);
    const phone = await signIn(call, user, { userAgent: FIREFOX_WINDOWS });

    const res = await call("POST", "/api/auth/sign-out-everywhere", undefined, { jar: laptop });
    expect(res.status).toBe(200);
    expect(laptop.get("ob_session")).toBeUndefined();
    for (const jar of [laptop, phone]) {
      expect((await me(call, jar)).status).toBe(401);
      expect((await refresh(call, jar)).status).toBe(401);
    }
    const row = await env.DB.prepare("SELECT session_epoch FROM users WHERE id = ?").bind(user.id).first();
    expect(row).toEqual({ session_epoch: 1 });
    const audit = await env.DB.prepare(
      "SELECT actor_id, target_id FROM audit_log WHERE action = 'session.sign_out_everywhere' AND actor_id = ?",
    )
      .bind(user.id)
      .first();
    expect(audit).toEqual({ actor_id: user.id, target_id: user.id });

    // Signing in again works.
    await signIn(call, user);
  });

  it("sign out everywhere needs a session and the CSRF header", async () => {
    const { call, jar } = await setup();
    expect((await call("POST", "/api/auth/sign-out-everywhere")).status).toBe(401);
    const res = await call("POST", "/api/auth/sign-out-everywhere", undefined, { jar, csrf: false });
    expect(await errorCode(res)).toBe("csrf_failed");
    expect((await me(call, jar)).status).toBe(200);
  });
});

describe("My devices", () => {
  it("lists active sessions with device, times and the current one", async () => {
    const clock = new Clock();
    const { call } = makeApp(clock);
    const user = await createUser();
    const laptop = await signIn(call, user);
    clock.advance(1000);
    const other = await signIn(call, user, { userAgent: FIREFOX_WINDOWS });

    const res = await call("GET", "/api/me/sessions", undefined, { jar: laptop });
    expect(res.status).toBe(200);
    const { sessions } = deviceSessionListSchema.parse(await res.json());
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: sessionIdOf(other), deviceLabel: "Firefox on Windows", current: false });
    expect(sessions[1]).toMatchObject({ id: sessionIdOf(laptop), deviceLabel: "Chrome on macOS", current: true });
    expect(sessions[1]?.createdAt).toBe(clock.value - 1000);
    expect(JSON.stringify(sessions)).not.toContain("Mozilla"); // the raw User-Agent isn't returned
  });

  it("signs out another device", async () => {
    const { call } = makeApp();
    const user = await createUser();
    const laptop = await signIn(call, user);
    const phone = await signIn(call, user);
    const res = await call("DELETE", `/api/me/sessions/${sessionIdOf(phone)}`, undefined, { jar: laptop });
    expect(res.status).toBe(200);
    expect((await me(call, phone)).status).toBe(401);
    expect((await me(call, laptop)).status).toBe(200);
    const list = deviceSessionListSchema.parse(
      await (await call("GET", "/api/me/sessions", undefined, { jar: laptop })).json(),
    );
    expect(list.sessions.map((s) => s.id)).toEqual([sessionIdOf(laptop)]);
  });

  it("can't sign out someone else's session: 404, and the session survives", async () => {
    const { call } = makeApp();
    const alice = await createUser();
    const bob = await createUser({ role: "owner" });
    const aliceJar = await signIn(call, alice);
    const bobJar = await signIn(call, bob);
    const res = await call("DELETE", `/api/me/sessions/${sessionIdOf(aliceJar)}`, undefined, { jar: bobJar });
    expect(res.status).toBe(404);
    expect((await me(call, aliceJar)).status).toBe(200);
    expect(
      (await call("DELETE", "/api/me/sessions/01JUNKJUNKJUNKJUNKJUNKJUNK", undefined, { jar: bobJar })).status,
    ).toBe(404);
  });

  it("signs out all other devices, keeping this one, and audits it", async () => {
    const { call } = makeApp();
    const user = await createUser();
    const current = await signIn(call, user);
    const others = [await signIn(call, user), await signIn(call, user)];
    const res = await call("POST", "/api/me/sessions/sign-out-others", undefined, { jar: current });
    expect(await res.json()).toEqual({ signedOut: 2 });
    for (const jar of others) expect((await me(call, jar)).status).toBe(401);
    expect((await me(call, current)).status).toBe(200);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'session.sign_out_others' AND actor_id = ?",
    )
      .bind(user.id)
      .first();
    expect(audit).toEqual({ n: 1 });
  });

  it("needs a session, and the CSRF header for changes", async () => {
    const { call, jar } = await setup();
    expect((await call("GET", "/api/me/sessions")).status).toBe(401);
    const res = await call("POST", "/api/me/sessions/sign-out-others", undefined, {
      jar,
      origin: "https://evil.example",
    });
    expect(await errorCode(res)).toBe("csrf_failed");
    const del = await call("DELETE", `/api/me/sessions/${sessionIdOf(jar)}`, undefined, { jar, csrf: false });
    expect(await errorCode(del)).toBe("csrf_failed");
    expect((await me(call, jar)).status).toBe(200);
  });
});
