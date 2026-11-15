import { meSchema } from "@officebox/shared";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Clock,
  CookieJar,
  createUser,
  ensureInstalled,
  errorCode,
  makeApp,
  signIn,
  uniqueEmail,
  uniqueIp,
} from "./helpers";

/**
 * Email and password sign-in (Identity §4.4, §9 "Sign-in" and "Rate limits"; Platform §8). Storage is
 * shared in this file, so every test creates its own users and uses its own IPs.
 */

beforeAll(async () => {
  await ensureInstalled();
});

describe("POST /api/auth/password", () => {
  it("signs in with the right password and sets the session cookies", async () => {
    const user = await createUser({ role: "admin" });
    const { call } = makeApp();
    const jar = new CookieJar();
    const res = await call(
      "POST",
      "/api/auth/password",
      { email: user.email.toUpperCase(), password: user.password },
      { jar },
    );
    expect(res.status).toBe(200);
    const me = meSchema.parse(await res.json());
    expect(me.user).toMatchObject({ id: user.id, email: user.email, role: "admin" });
    expect(me.workspace.name).toBeTypeOf("string");

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("ob_session="));
    const refresh = cookies.find((c) => c.startsWith("ob_refresh="));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\/(;|$)/);
    expect(session).toMatch(/Max-Age=900/);
    expect(refresh).toMatch(/HttpOnly/);
    expect(refresh).toMatch(/Secure/);
    expect(refresh).toMatch(/SameSite=Lax/);
    expect(refresh).toMatch(/Path=\/api\/auth/);
    expect(refresh).toMatch(/Max-Age=2592000/);

    const again = await call("GET", "/api/me", undefined, { jar });
    expect(again.status).toBe(200);
    expect(meSchema.parse(await again.json()).user.id).toBe(user.id);
  });

  it("refuses a wrong password and an unknown email with the same error", async () => {
    const user = await createUser();
    const { call } = makeApp();
    const wrong = await call("POST", "/api/auth/password", { email: user.email, password: "not-the-password" });
    const unknown = await call("POST", "/api/auth/password", { email: uniqueEmail(), password: "not-the-password" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a: { error: unknown } = await wrong.json();
    const b: { error: unknown } = await unknown.json();
    expect(a.error).toEqual(b.error);
    expect(a.error).toEqual({ code: "invalid_credentials", message: "The email or password is incorrect." });
    expect(wrong.headers.getSetCookie()).toEqual([]);
  });

  it("gives disabled and deleted members a generic refusal, and only after the right password", async () => {
    const { call } = makeApp();
    const disabled = await createUser({ status: "disabled" });
    const right = await call("POST", "/api/auth/password", { email: disabled.email, password: disabled.password });
    expect(right.status).toBe(403);
    expect(right.headers.getSetCookie()).toEqual([]);
    const wrong = await call("POST", "/api/auth/password", { email: disabled.email, password: "nope-nope-nope" });
    expect(await errorCode(wrong)).toBe("invalid_credentials");

    const deleted = await createUser({ status: "deleted" });
    const gone = await call("POST", "/api/auth/password", { email: deleted.email, password: deleted.password });
    expect(await errorCode(gone)).toBe("invalid_credentials");
  });

  it("needs the CSRF header and a matching Origin (login CSRF)", async () => {
    const user = await createUser();
    const { call } = makeApp();
    const creds = { email: user.email, password: user.password };
    for (const options of [{ csrf: false }, { origin: "https://evil.example" }, { origin: null }, { origin: "null" }]) {
      const res = await call("POST", "/api/auth/password", creds, options);
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("csrf_failed");
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it("validates the body", async () => {
    const { call } = makeApp();
    const res = await call("POST", "/api/auth/password", { email: "not-an-email", password: "x" });
    expect(await errorCode(res)).toBe("validation_failed");
    const extra = await call("POST", "/api/auth/password", { email: "a@example.com", password: "x", remember: true });
    expect(await errorCode(extra)).toBe("validation_failed");
  });

  it("answers unavailable when the secrets are missing", async () => {
    const user = await createUser();
    const { call } = makeApp();
    const res = await call(
      "POST",
      "/api/auth/password",
      { email: user.email, password: user.password },
      { env: { ...env, SESSION_SIGNING_KEY: undefined } },
    );
    expect(res.status).toBe(503);
  });
});

describe("rate limits (Identity §4.4, §9; Platform §8)", () => {
  it("the 6th attempt within a minute from one IP is refused with a retry-after", async () => {
    const { call } = makeApp();
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      // Different accounts, so only the IP limit applies.
      const res = await call(
        "POST",
        "/api/auth/password",
        { email: uniqueEmail(), password: "wrong-password" },
        { ip },
      );
      statuses.push(res.status);
      if (res.status === 429) expect(res.headers.get("Retry-After")).toBe("60");
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("per account: attempts 1–5 are immediate, then 1 s, 2 s, 4 s, 8 s, 16 s, 30 s (cap); no lockout", async () => {
    const user = await createUser();
    const clock = new Clock();
    const { call } = makeApp(clock);
    const attempt = (password = "wrong-password") =>
      call("POST", "/api/auth/password", { email: user.email, password }, { ip: uniqueIp() });

    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);

    for (const delaySeconds of [1, 2, 4, 8, 16, 30, 30]) {
      const early = await attempt();
      expect(early.status).toBe(429);
      expect(early.headers.get("Retry-After")).toBe(String(delaySeconds));
      clock.advance(delaySeconds * 1000 - 1);
      expect((await attempt()).status).toBe(429); // still 1 ms early, and not counted
      clock.advance(1);
      expect((await attempt()).status).toBe(401);
    }

    // The 13th attempt within the hour, with the right password after the wait, succeeds.
    clock.advance(30_000);
    expect((await attempt(user.password)).status).toBe(200);
    // Success resets the schedule.
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });

  it("the 11th failure within an hour is delayed; an hour of quiet starts afresh", async () => {
    const user = await createUser();
    const clock = new Clock();
    const { call } = makeApp(clock);
    const attempt = () =>
      call("POST", "/api/auth/password", { email: user.email, password: "bad-password" }, { ip: uniqueIp() });
    for (let i = 0; i < 10; i++) {
      expect((await attempt()).status).toBe(401);
      clock.advance(30_000); // always waiting long enough
    }
    clock.advance(-30_000);
    const eleventh = await attempt();
    expect(eleventh.status).toBe(429);
    clock.advance(60 * 60 * 1000);
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
  });

  it("unknown emails are throttled exactly like real accounts", async () => {
    const clock = new Clock();
    const { call } = makeApp(clock);
    const email = uniqueEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await call("POST", "/api/auth/password", { email, password: "whatever-pw" }, { ip: uniqueIp() })).status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("parallel guesses can't slip past the schedule", async () => {
    const user = await createUser();
    const clock = new Clock();
    const { call } = makeApp(clock);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        call("POST", "/api/auth/password", { email: user.email, password: "guess-guess" }, { ip: uniqueIp() }),
      ),
    );
    expect(results.filter((r) => r.status === 401)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });
});

describe("pepper rotation (Identity §4.4)", () => {
  const PEPPER_2 = "rotated-pepper-two-0123456789abcdefghijklmnop";

  it("re-hashes with the newest pepper at the next successful sign-in", async () => {
    const user = await createUser();
    const { call } = makeApp();
    const rotated = { ...env, PEPPER_2 };
    await signIn(call, user, { env: rotated });
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ password_hash: string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2-sha256-hmac\$2\$100000\$/);
    // Still signs in with the new pepper alone.
    await signIn(call, user, { env: { ...env, PEPPER_1: undefined, PEPPER_2 } });
  });

  it("after the old pepper is deleted, accounts still on it can't sign in with a password", async () => {
    const user = await createUser();
    const { call } = makeApp();
    const res = await call(
      "POST",
      "/api/auth/password",
      { email: user.email, password: user.password },
      { env: { ...env, PEPPER_1: undefined, PEPPER_2 } },
    );
    expect(await errorCode(res)).toBe("invalid_credentials");
  });

  it("a wrong password doesn't re-hash", async () => {
    const user = await createUser();
    const { call } = makeApp();
    const before = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
    await call(
      "POST",
      "/api/auth/password",
      { email: user.email, password: "wrong-password" },
      { env: { ...env, PEPPER_2 } },
    );
    const after = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
    expect(after).toEqual(before);
  });
});
