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
  // The per-IP binding (5 per minute, real time) would stop these schedules at the 6th attempt from
  // one IP; the binding has its own test below, so these use a binding that always allows.
  const openBinding = { ...env, AUTH_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) } };
  type Call = ReturnType<typeof makeApp>["call"];
  const attemptFrom = (call: Call, email: string, password: string, ip: string, jar?: CookieJar) =>
    call("POST", "/api/auth/password", { email, password }, { ip, env: openBinding, jar });
  /** A clock a minute into an hour, so the hour-based tests don't straddle a boundary. */
  const hourClock = () => new Clock(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 60_000);
  /** 10 distinct IPs each fail once: the account goes into slow mode. Returns those (now dirty) IPs. */
  async function tripSlowMode(call: Call, email: string): Promise<string[]> {
    const ips = Array.from({ length: 10 }, () => uniqueIp());
    for (const ip of ips) expect((await attemptFrom(call, email, "guess", ip)).status).toBe(401);
    return ips;
  }
  /** A dirty IP takes the shared slot (expects the slot to be open). */
  async function takeSlot(call: Call, email: string, dirtyIp: string) {
    expect((await attemptFrom(call, email, "guess", dirtyIp)).status).toBe(401);
  }
  /** A jar holding only the known-device marker from a successful sign-in. */
  async function knownDeviceFor(call: Call, user: { email: string; password: string }) {
    const jar = new CookieJar();
    const res = await attemptFrom(call, user.email, user.password, uniqueIp(), jar);
    expect(res.status).toBe(200);
    const device = new CookieJar();
    device.values.set("ob_device", jar.get("ob_device") ?? "");
    return device;
  }

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

  it("per account and IP: attempts 1–5 are immediate, then 1 s, 2 s, 4 s, 8 s, 16 s, 30 s (cap)", async () => {
    const user = await createUser();
    const clock = new Clock();
    const { call } = makeApp(clock);
    const ip = uniqueIp();
    const attempt = (password = "wrong-password") => attemptFrom(call, user.email, password, ip);

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

    // The right password after the wait succeeds, and success resets the schedule.
    clock.advance(30_000);
    expect((await attempt(user.password)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });

  it("the 11th failure within an hour from one IP is delayed; an hour of quiet starts afresh", async () => {
    const user = await createUser();
    const clock = new Clock();
    const { call } = makeApp(clock);
    const ip = uniqueIp();
    const attempt = () => attemptFrom(call, user.email, "bad-password", ip);
    for (let i = 0; i < 10; i++) {
      expect((await attempt()).status).toBe(401);
      clock.advance(30_000);
    }
    clock.advance(-30_000);
    expect((await attempt()).status).toBe(429);
    clock.advance(60 * 60 * 1000);
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
  });

  it("one IP can't trip slow mode: after an hour of max-rate guessing, a new browser elsewhere signs in at once", async () => {
    const user = await createUser();
    const clock = hourClock();
    const { call } = makeApp(clock);
    const attacker = uniqueIp();
    const end = clock.value + 58 * 60_000;
    let counted = 0;
    while (clock.value < end) {
      const res = await attemptFrom(call, user.email, "guess-guess", attacker);
      if (res.status === 401) counted++;
      else clock.advance(Number(res.headers.get("Retry-After")) * 1000);
    }
    expect(counted).toBeGreaterThan(100); // every slot the schedule allowed
    expect((await attemptFrom(call, user.email, user.password, uniqueIp())).status).toBe(200);
  });

  it("IPv6 addresses in one /64 share a bucket", async () => {
    const user = await createUser();
    const { call } = makeApp(new Clock());
    for (let i = 1; i <= 5; i++) {
      expect((await attemptFrom(call, user.email, "nope-nope", `2001:db8:1:2::${i}`)).status).toBe(401);
    }
    expect((await attemptFrom(call, user.email, "nope-nope", "2001:db8:1:2:ffff::9")).status).toBe(429);
    expect((await attemptFrom(call, user.email, "nope-nope", "2001:db8:1:3::1")).status).toBe(401);
  });

  it("in slow mode, an attacker taking the slot every 30 s doesn't stop the owner on a clean IP", async () => {
    const user = await createUser();
    const clock = hourClock();
    const { call } = makeApp(clock);
    const dirty = await tripSlowMode(call, user.email);
    // The attacker retries at every slot opening for ten minutes, from IPs already in the set.
    for (let i = 0; i < 20; i++) {
      await takeSlot(call, user.email, dirty[i % dirty.length] ?? "");
      clock.advance(30_000);
    }
    await takeSlot(call, user.email, dirty[0] ?? "");
    // The owner, on a new browser from their usual (clean) IP, gets in at once.
    expect((await attemptFrom(call, user.email, user.password, uniqueIp())).status).toBe(200);
  });

  it("each attacker IP gets exactly one clean-lane attempt, then queues for the slot", async () => {
    const user = await createUser();
    const clock = hourClock();
    const { call } = makeApp(clock);
    const dirty = await tripSlowMode(call, user.email);
    await takeSlot(call, user.email, dirty[0] ?? "");
    const fresh = uniqueIp();
    expect((await attemptFrom(call, user.email, "guess", fresh)).status).toBe(401); // the clean lane
    const queued = await attemptFrom(call, user.email, "guess", fresh);
    expect(queued.status).toBe(429);
    expect(queued.headers.get("Retry-After")).toBe("30");
    // Unknown devices on a dirty IP still get in, through the slot.
    clock.advance(30_000);
    expect((await attemptFrom(call, user.email, user.password, dirty[1] ?? "")).status).toBe(200);
  });

  it("parallel requests from many fresh IPs: one password check per IP, repeats blocked by the slot", async () => {
    const user = await createUser();
    const clock = hourClock();
    const { call } = makeApp(clock);
    const dirty = await tripSlowMode(call, user.email);
    await takeSlot(call, user.email, dirty[0] ?? "");
    const ips = Array.from({ length: 30 }, () => uniqueIp());
    const results = await Promise.all(
      ips.flatMap((ip) => [0, 1, 2].map(() => attemptFrom(call, user.email, "guess", ip))),
    );
    expect(results.filter((r) => r.status === 401)).toHaveLength(30); // bounded by the number of IPs
    expect(results.filter((r) => r.status === 429)).toHaveLength(60);
    // Repeats from dirty IPs share the slot: exactly one gets through when it opens.
    clock.advance(30_000);
    const repeats = await Promise.all(dirty.map((ip) => attemptFrom(call, user.email, "guess", ip)));
    expect(repeats.filter((r) => r.status === 401)).toHaveLength(1);
  });

  it("a request the per-IP schedule refuses doesn't take the shared slot", async () => {
    const user = await createUser();
    const clock = hourClock();
    const { call } = makeApp(clock);
    const busy = uniqueIp();
    for (let i = 0; i < 5; i++) expect((await attemptFrom(call, user.email, "guess", busy)).status).toBe(401);
    const others = Array.from({ length: 9 }, () => uniqueIp());
    for (const ip of others) expect((await attemptFrom(call, user.email, "guess", ip)).status).toBe(401);
    // Slow mode now (10 buckets). The busy IP is still in its per-IP wait: refused there...
    expect((await attemptFrom(call, user.email, "guess", busy)).status).toBe(429);
    // ...so the slot is still open for the next queued request.
    expect((await attemptFrom(call, user.email, user.password, others[0] ?? "")).status).toBe(200);
  });

  it("known devices are unaffected by slow mode, and a marker for another account doesn't help", async () => {
    const user = await createUser();
    const clock = hourClock();
    const { call } = makeApp(clock);
    const device = await knownDeviceFor(call, user);
    const other = await createUser();
    const otherDevice = await knownDeviceFor(call, other);
    const dirty = await tripSlowMode(call, user.email);
    await takeSlot(call, user.email, dirty[0] ?? "");

    expect((await attemptFrom(call, user.email, user.password, dirty[1] ?? "", otherDevice)).status).toBe(429);
    for (const ip of dirty.slice(1, 4)) {
      expect((await attemptFrom(call, user.email, user.password, ip, device)).status).toBe(200);
    }
  });

  it("sign out everywhere and a password change invalidate the marker; a re-hash doesn't", async () => {
    const user = await createUser();
    const clock = hourClock();
    const { call } = makeApp(clock);
    const device = await knownDeviceFor(call, user);
    const dirty = await tripSlowMode(call, user.email);
    await takeSlot(call, user.email, dirty[0] ?? "");
    const viaDirtyIp = (jar: CookieJar, env2 = openBinding) =>
      call(
        "POST",
        "/api/auth/password",
        { email: user.email, password: user.password },
        { ip: dirty[1], env: env2, jar },
      );

    // A pepper rotation re-hashes the password on this sign-in; the marker stays valid.
    const before = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
    const rotated = { ...openBinding, PEPPER_2: "rotated-pepper-two-0123456789abcdefghijklmnop" };
    expect((await viaDirtyIp(device.clone(), rotated)).status).toBe(200);
    const after = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
    expect(after).not.toEqual(before);
    expect((await viaDirtyIp(device.clone(), rotated)).status).toBe(200);

    // A password change (M1c bumps password_version) invalidates it: back to the taken slot.
    await env.DB.prepare("UPDATE users SET password_version = password_version + 1 WHERE id = ?").bind(user.id).run();
    expect((await viaDirtyIp(device.clone(), rotated)).status).toBe(429);

    // So does sign out everywhere, for a marker issued after the change.
    clock.advance(30_000);
    const signedIn = new CookieJar();
    expect((await viaDirtyIp(signedIn, rotated)).status).toBe(200); // takes the reopened slot
    const fresh = new CookieJar();
    fresh.values.set("ob_device", signedIn.get("ob_device") ?? "");
    expect((await viaDirtyIp(fresh.clone(), rotated)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?").bind(user.id).run();
    expect((await viaDirtyIp(fresh.clone(), rotated)).status).toBe(429);
  });

  it("a known device behind a shared IP isn't delayed by others failing from that IP", async () => {
    const user = await createUser();
    const { call } = makeApp(new Clock());
    const office = uniqueIp();
    const device = await knownDeviceFor(call, user);
    for (let i = 0; i < 5; i++) expect((await attemptFrom(call, user.email, "guess", office)).status).toBe(401);
    expect((await attemptFrom(call, user.email, "guess", office)).status).toBe(429);
    expect((await attemptFrom(call, user.email, user.password, office, device)).status).toBe(200);
  });

  it("successful sign-ins never count towards slow mode", async () => {
    const user = await createUser();
    const { call } = makeApp(hourClock());
    for (let i = 0; i < 25; i++) {
      expect((await attemptFrom(call, user.email, user.password, uniqueIp())).status).toBe(200);
    }
  });

  it("unknown emails behave exactly like real accounts, per IP and in slow mode", async () => {
    const clock = hourClock();
    const { call } = makeApp(clock);
    const email = uniqueEmail();
    const ip = uniqueIp();
    const perIp: number[] = [];
    for (let i = 0; i < 6; i++) perIp.push((await attemptFrom(call, email, "whatever-pw", ip)).status);
    expect(perIp).toEqual([401, 401, 401, 401, 401, 429]);

    const other = uniqueEmail();
    const dirty = await tripSlowMode(call, other);
    await takeSlot(call, other, dirty[0] ?? "");
    const fresh = uniqueIp();
    expect((await attemptFrom(call, other, "guess", fresh)).status).toBe(401); // clean lane
    const slowed = await attemptFrom(call, other, "guess", fresh);
    expect(slowed.status).toBe(429);
    expect(slowed.headers.get("Retry-After")).toBe("30");
  });

  it("parallel guesses from one IP can't slip past the schedule", async () => {
    const user = await createUser();
    const { call } = makeApp(new Clock());
    const ip = uniqueIp();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => attemptFrom(call, user.email, "guess-guess", ip)),
    );
    expect(results.filter((r) => r.status === 401)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });

  it("sets the known-device marker only after a successful sign-in, HttpOnly and scoped to /api/auth", async () => {
    const user = await createUser();
    const { call } = makeApp();
    const failed = await attemptFrom(call, user.email, "wrong-password", uniqueIp());
    expect(failed.headers.getSetCookie().some((c) => c.startsWith("ob_device="))).toBe(false);
    const ok = await attemptFrom(call, user.email, user.password, uniqueIp());
    const marker = ok.headers.getSetCookie().find((c) => c.startsWith("ob_device="));
    expect(marker).toMatch(/HttpOnly/);
    expect(marker).toMatch(/Secure/);
    expect(marker).toMatch(/SameSite=Lax/);
    expect(marker).toMatch(/Path=\/api\/auth/);
    expect(marker).toMatch(/Max-Age=34560000/);
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
