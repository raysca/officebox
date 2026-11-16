import { env } from "cloudflare:workers";
import { SETUP_OPEN_WINDOW_MS, type SetupStatus } from "@officebox/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/log";
import { SETUP_CLAIM_TTL_MS, startOpenWindow } from "../../src/features/identity/setup";
import type { Env } from "../../src/env";
import { SoftAuthenticator } from "./authenticator";
import {
  Browser,
  callWorker,
  claim,
  failingDb,
  ORIGIN,
  ownerDetails,
  registerPasskey,
  resetInstallation,
  seedSetupToken,
  SETUP_TOKEN,
  useTestClock,
  type OwnerDetails,
  type TestClock,
} from "./helpers";

/**
 * Quick start (M1b-1; Identity §4.1, §9; TDD §6.8): the open claim window and the required-services
 * check, on an injected clock (never sleeps). The tests have no `SETUP_TOKEN` secret unless a test
 * passes one, so the window applies.
 */

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const silent = createLogger({}, () => {});
let clock: TestClock;

const openedAt = async () =>
  (
    await env.DB.prepare("SELECT setup_opened_at FROM installation WHERE id = 1").first<{
      setup_opened_at: number | null;
    }>()
  )?.setup_opened_at ?? null;
const claimRow = async () =>
  (await env.DB.prepare("SELECT setup_claim FROM installation WHERE id = 1").first<{ setup_claim: string | null }>())
    ?.setup_claim ?? null;
const status = (browser = new Browser(), overrides: Partial<Env> = {}) =>
  browser.json<SetupStatus & { error?: { code: string } }>("/api/setup", { env: overrides });

/** A claim without a token (an open-mode claim). */
function openClaim(browser: Browser, owner: OwnerDetails = ownerDetails(), overrides: Partial<Env> = {}) {
  return browser.json<{ ownerEmail?: string; resumeCode?: string; error?: { code: string } }>("/api/setup", {
    body: {
      workspaceName: owner.workspace,
      ownerName: owner.name,
      ownerHandle: owner.handle,
      ownerEmail: owner.email,
    },
    env: overrides,
  });
}

beforeEach(async () => {
  await resetInstallation();
  await env.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'setup.%'").run();
  clock = useTestClock(T0);
});
afterEach(() => {
  useTestClock(null);
});

describe("the open claim window (Identity §4.1)", () => {
  it("the first GET /setup with every service passing starts it; later requests never move it", async () => {
    const first = await status();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ mode: "open", openUntil: T0 + SETUP_OPEN_WINDOW_MS, claimed: false });
    expect(first.body.services.every((s) => s.ok)).toBe(true);
    expect(await openedAt()).toBe(T0);
    clock.now = T0 + 10 * 60_000;
    expect((await status()).body).toMatchObject({ mode: "open", openUntil: T0 + SETUP_OPEN_WINDOW_MS });
    expect(await openedAt()).toBe(T0);
  });

  it("concurrent first requests record one start time", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => status()));
    expect(new Set(results.map((r) => r.body.openUntil))).toEqual(new Set([T0 + SETUP_OPEN_WINDOW_MS]));
    // Different clocks racing straight at the write: exactly one value lands, and nothing moves it after.
    await resetInstallation();
    const times = [T0 + 1, T0 + 2, T0 + 3, T0 + 4];
    await Promise.all(times.map((t) => startOpenWindow({ env, log: silent, now: () => t })));
    const recorded = await openedAt();
    expect(times).toContain(recorded);
    await startOpenWindow({ env, log: silent, now: () => T0 + 99 });
    expect(await openedAt()).toBe(recorded);
  });

  it("/health, static pages and other routes don't start it", async () => {
    await callWorker(new Request(`${ORIGIN}/health`));
    await callWorker(new Request(`${ORIGIN}/setup`));
    await callWorker(new Request(`${ORIGIN}/`));
    await new Browser().json("/api/me");
    await new Browser().json("/api/status/public");
    expect(await openedAt()).toBeNull();
  });

  it("a claim without a token succeeds inside the window, up to its last millisecond", async () => {
    await status();
    clock.now = T0 + SETUP_OPEN_WINDOW_MS - 1;
    const owner = ownerDetails();
    const result = await openClaim(new Browser(), owner);
    expect(result.status).toBe(201);
    expect(result.body.ownerEmail).toBe(owner.email);
    expect(result.body.resumeCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await claimRow()).not.toBeNull();
  });

  it("a claim at the end of the window, or one millisecond after, answers setup_token_required", async () => {
    await status();
    for (const at of [T0 + SETUP_OPEN_WINDOW_MS, T0 + SETUP_OPEN_WINDOW_MS + 1]) {
      clock.now = at;
      const late = await openClaim(new Browser());
      expect(late.status).toBe(403);
      expect(late.body).toMatchObject({ error: { code: "setup_token_required" } });
      expect(await claimRow()).toBeNull();
      expect((await status()).body).toMatchObject({ mode: "token" });
      expect((await status()).body.openUntil).toBeUndefined();
    }
  });

  it("the window is checked inside the claim's atomic condition, not only before it", async () => {
    // A window that ended between the status read and the claim: the UPDATE itself refuses.
    await status();
    await env.DB.prepare("UPDATE installation SET setup_opened_at = ? WHERE id = 1")
      .bind(T0 - SETUP_OPEN_WINDOW_MS)
      .run();
    const late = await openClaim(new Browser());
    expect(late.body).toMatchObject({ error: { code: "setup_token_required" } });
    expect(await claimRow()).toBeNull();
  });

  it("after the window, the token flow applies unchanged", async () => {
    // A known generated token (generated-token mode), as if read from Workers Logs.
    await seedSetupToken(SETUP_TOKEN, T0 + SETUP_CLAIM_TTL_MS);
    await status();
    clock.now = T0 + SETUP_OPEN_WINDOW_MS + 5;
    expect((await claim(new Browser(), ownerDetails(), "wrong-token-0123456789abcdefghijklmnopq")).status).toBe(403);
    const result = await claim(new Browser(), ownerDetails(), SETUP_TOKEN);
    expect(result.status).toBe(201);
    const entry = await env.DB.prepare("SELECT metadata FROM audit_log WHERE action = 'setup.claim'").first<{
      metadata: string;
    }>();
    expect(JSON.parse(entry!.metadata)).toEqual({ mode: "token", setupVia: "generated" });
  });

  it("the generated token is still generated and logged on the first visit, and works inside the window", async () => {
    await status();
    const row = await env.DB.prepare("SELECT setup_token_hash FROM installation WHERE id = 1").first<{
      setup_token_hash: string | null;
    }>();
    expect(row?.setup_token_hash).toBeTruthy();
    await seedSetupToken(SETUP_TOKEN, T0 + SETUP_CLAIM_TTL_MS);
    const result = await claim(new Browser(), ownerDetails(), SETUP_TOKEN);
    expect(result.status).toBe(201);
    expect(result.body).not.toHaveProperty("resumeCode");
  });

  it("with SETUP_TOKEN set there is no window: mode token from the first request, and a claim needs the token", async () => {
    const secret = { SETUP_TOKEN };
    const first = await status(new Browser(), secret);
    expect(first.body).toMatchObject({ mode: "token", tokenSource: "secret" });
    expect(first.body.openUntil).toBeUndefined();
    expect(await openedAt()).toBeNull();
    const without = await openClaim(new Browser(), ownerDetails(), secret);
    expect(without.status).toBe(403);
    expect(without.body).toMatchObject({ error: { code: "setup_token_required" } });
    expect(await openedAt()).toBeNull();
    const withToken = await new Browser().json("/api/setup", {
      body: { token: SETUP_TOKEN, ...bodyOf(ownerDetails()) },
      env: secret,
    });
    expect(withToken.status).toBe(201);
  });

  it("a claim can be the first setup request: it starts the window and succeeds", async () => {
    const result = await openClaim(new Browser());
    expect(result.status).toBe(201);
    expect(await openedAt()).toBe(T0);
  });

  it("concurrent claims inside the window: exactly one wins", async () => {
    await status();
    const results = await Promise.all(Array.from({ length: 5 }, () => openClaim(new Browser())));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const owners = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE role = 'owner'").first<{ n: number }>();
    expect(owners?.n).toBe(1);
  });

  it("an expired claim doesn't reopen the window", async () => {
    await status();
    expect((await openClaim(new Browser())).status).toBe(201);
    clock.now = T0 + SETUP_CLAIM_TTL_MS + SETUP_OPEN_WINDOW_MS;
    const after = await status();
    expect(after.body).toMatchObject({ claimed: false, mode: "token" });
    expect(await openedAt()).toBe(T0);
    expect((await openClaim(new Browser())).body).toMatchObject({ error: { code: "setup_token_required" } });
  });

  it("the claim is audited with its mode and logs 'officebox setup claimed' without the email or name", async () => {
    await status();
    const owner = ownerDetails();
    expect((await openClaim(new Browser(), owner)).status).toBe(201);
    const entry = await env.DB.prepare("SELECT metadata FROM audit_log WHERE action = 'setup.claim'").first<{
      metadata: string;
    }>();
    expect(JSON.parse(entry!.metadata)).toEqual({ mode: "open" });
    const lines = clock.lines.filter((l) => l.includes("officebox setup claimed"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      mode: "open",
      origin: ORIGIN,
      claimedAt: new Date(T0).toISOString(),
    });
    for (const line of clock.lines) {
      expect(line).not.toContain(owner.email);
      expect(line).not.toContain(owner.name);
    }
  });
});

function bodyOf(owner: OwnerDetails) {
  return {
    workspaceName: owner.workspace,
    ownerName: owner.name,
    ownerHandle: owner.handle,
    ownerEmail: owner.email,
  };
}

describe("a claim whose later steps fail is undone (review finding)", () => {
  it("if the resume code can't be written, the owner, handle and claim are removed, so setup can be tried again at once", async () => {
    await status();
    const owner = ownerDetails();
    const broken = failingDb((sql) => sql.includes("'setup_resume'"));
    const failed = await openClaim(new Browser(), owner, { DB: broken });
    expect(failed.status).toBe(500);
    expect(await claimRow()).toBeNull();
    const left = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM users WHERE email = ?1) AS users, (SELECT count(*) FROM handles WHERE handle = ?2) AS handles",
    )
      .bind(owner.email, owner.handle)
      .first<{ users: number; handles: number }>();
    expect(left).toEqual({ users: 0, handles: 0 });
    // The window is untouched, and the same person can claim again straight away.
    expect(await openedAt()).toBe(T0);
    expect((await openClaim(new Browser(), owner)).status).toBe(201);
  });

  it("the same holds when the enrolment ticket can't be issued (token mode)", async () => {
    await seedSetupToken(SETUP_TOKEN, T0 + SETUP_CLAIM_TTL_MS);
    const broken = failingDb((sql) => sql.includes("'passkey_enrol'") && sql.startsWith("INSERT"));
    const failed = await new Browser().json("/api/setup", {
      body: { token: SETUP_TOKEN, ...bodyOf(ownerDetails()) },
      env: { DB: broken },
    });
    expect(failed.status).toBe(500);
    expect(await claimRow()).toBeNull();
    expect((await claim(new Browser(), ownerDetails(), SETUP_TOKEN)).status).toBe(201);
  });
});

describe("the setup resume code (Identity §2 'Resuming an open-window claim')", () => {
  it("resumes registration for that owner only, on any device, under the same 410 guards", async () => {
    await status();
    const owner = ownerDetails();
    const claimed = await openClaim(new Browser(), owner);
    const code = claimed.body.resumeCode!;
    // Shown once: a status request never returns it.
    expect(JSON.stringify((await status()).body)).not.toContain(code);
    const other = new Browser();
    const resumed = await other.json("/api/setup/resume", { body: { token: code } });
    expect(resumed.status).toBe(201);
    expect(resumed.body).toMatchObject({ ownerEmail: owner.email });
    expect(resumed.body).not.toHaveProperty("resumeCode");
    expect(other.cookies.get("__Host-officebox-enrol")).toBeTruthy();
    expect((await new Browser().json("/api/setup/resume", { body: { token: `${code}x` } })).status).toBe(403);
    // Once the owner has a passkey, resume answers 410.
    const reg = await registerPasskey(other, new SoftAuthenticator());
    expect(reg.verify?.status).toBe(200);
    // Setup is complete now, so /setup/resume is 404 like /setup.
    expect((await new Browser().json("/api/setup/resume", { body: { token: code } })).status).toBe(404);
  });

  it("answers 410 once the owner has signed in, before completion", async () => {
    await status();
    const claimed = await openClaim(new Browser());
    await env.DB.prepare("UPDATE users SET first_signed_in_at = ? WHERE role = 'owner'").bind(T0).run();
    const resumed = await new Browser().json("/api/setup/resume", { body: { token: claimed.body.resumeCode } });
    expect(resumed.status).toBe(410);
  });

  it("is refused after the claim expires", async () => {
    await status();
    const claimed = await openClaim(new Browser());
    clock.now = T0 + SETUP_CLAIM_TTL_MS + 1;
    const resumed = await new Browser().json("/api/setup/resume", { body: { token: claimed.body.resumeCode } });
    expect(resumed.status).toBe(403);
  });

  it("is stored only as a hash, as an auth_tokens row of kind setup_resume", async () => {
    await status();
    const claimed = await openClaim(new Browser());
    const { results } = await env.DB.prepare("SELECT * FROM auth_tokens WHERE kind = 'setup_resume'").all();
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain(claimed.body.resumeCode!);
    expect(results[0]).toMatchObject({ expires_at: T0 + SETUP_CLAIM_TTL_MS });
  });
});

describe("the required-services check (Identity §4.1; TDD §6.8)", () => {
  const throwingR2 = {
    head: () => Promise.reject(new Error("R2 bucket officebox-files in account 0123456789abcdef is disabled")),
  } as unknown as R2Bucket;
  const unreachableSystem = {
    getByName: () => ({
      ping: () => Promise.reject(new Error("Durable Object unreachable")),
      generatedKey: () => Promise.reject(new Error("Durable Object unreachable")),
    }),
  } as unknown as Env["SYSTEM"];
  // A D1 whose installation table has no setup_opened_at column yet: the error SQLite gives.
  const pendingDb = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("setup_opened_at FROM installation LIMIT 0")) {
            throw new Error("D1_ERROR: no such column: setup_opened_at: SQLITE_ERROR");
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  const cases: { name: string; env: Partial<Env>; service: string; problem: string }[] = [
    { name: "no FILES binding", env: { FILES: undefined }, service: "r2", problem: "missing" },
    { name: "an R2 head that throws", env: { FILES: throwingR2 }, service: "r2", problem: "unreachable" },
    { name: "a broken D1", env: { DB: failingDb(() => true) }, service: "d1", problem: "unreachable" },
    { name: "migrations not applied", env: { DB: pendingDb }, service: "d1", problem: "migrations_pending" },
    {
      name: "an unreachable SystemObject",
      env: { SYSTEM: unreachableSystem },
      service: "durable_objects",
      problem: "unreachable",
    },
    { name: "a missing queue binding", env: { EMAIL_QUEUE: undefined }, service: "queues", problem: "missing" },
    {
      name: "a set-but-short TOKEN_HASH_KEY",
      env: { TOKEN_HASH_KEY: "short" },
      service: "token_hash_key",
      problem: "invalid_secret",
    },
    {
      name: "a set-but-short BETTER_AUTH_SECRET",
      env: { BETTER_AUTH_SECRET: "short" },
      service: "better_auth_secret",
      problem: "invalid_secret",
    },
    {
      name: "generated keys with the SystemObject unreachable",
      env: { SYSTEM: unreachableSystem, TOKEN_HASH_KEY: "" },
      service: "token_hash_key",
      problem: "unreachable",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: reported with its problem code, claims refused, and the window doesn't start`, async () => {
      const browser = new Browser();
      const report = await status(browser, c.env);
      expect(report.status).toBe(200);
      expect(report.body.services).toContainEqual({ id: c.service, ok: false, problem: c.problem });
      expect(report.body.mode).toBe("token");
      const refused = await openClaim(browser, ownerDetails(), c.env);
      expect(refused.status).toBe(503);
      expect(refused.body).toMatchObject({ error: { code: "setup_services_failing" } });
      // With a token too: no claim of any kind while a service fails.
      const tokenClaim = await browser.json("/api/setup", {
        body: { token: SETUP_TOKEN, ...bodyOf(ownerDetails()) },
        env: c.env,
      });
      expect(tokenClaim.body).toMatchObject({ error: { code: "setup_services_failing" } });
      expect(await openedAt()).toBeNull();
      expect(await claimRow()).toBeNull();
      // No value, length, account or resource ID, or raw error, in the output.
      for (const body of browser.bodies) {
        expect(body).not.toMatch(/0123456789abcdef|officebox-files|SQLITE|D1_ERROR|unreachable"\s*:|short/);
        expect(body).not.toContain(env.TOKEN_HASH_KEY!);
        expect(body).not.toContain(env.BETTER_AUTH_SECRET!);
      }
      // Once everything passes, the window starts.
      expect((await status()).body).toMatchObject({ mode: "open" });
      expect(await openedAt()).toBe(T0);
    });
  }

  it("a failure after the window started blocks claims but doesn't pause or extend the window", async () => {
    await status();
    clock.now = T0 + 30 * 60_000;
    const blocked = await openClaim(new Browser(), ownerDetails(), { FILES: undefined as unknown as R2Bucket });
    expect(blocked.body).toMatchObject({ error: { code: "setup_services_failing" } });
    const later = await status(new Browser(), { FILES: undefined as unknown as R2Bucket });
    expect(later.body).toMatchObject({ mode: "open", openUntil: T0 + SETUP_OPEN_WINDOW_MS });
    clock.now = T0 + SETUP_OPEN_WINDOW_MS;
    expect((await openClaim(new Browser())).body).toMatchObject({ error: { code: "setup_token_required" } });
  });

  it("a completely unmigrated D1 (no installation table) shows migrations_pending, not a 500", async () => {
    const empty = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/installation/.test(sql)) throw new Error("D1_ERROR: no such table: installation: SQLITE_ERROR");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const browser = new Browser();
    const report = await status(browser, { DB: empty });
    expect(report.status).toBe(200);
    expect(report.body.services).toContainEqual({ id: "d1", ok: false, problem: "migrations_pending" });
    expect(report.body).toMatchObject({ mode: "token", claimed: false });
    const refused = await openClaim(browser, ownerDetails(), { DB: empty });
    expect(refused.body).toMatchObject({ error: { code: "setup_services_failing" } });
    expect(browser.bodies.join("\n")).not.toMatch(/SQLITE|D1_ERROR|no such table/);
  });

  it("the services are listed in a fixed order, with no detail beyond the problem code", async () => {
    const report = await status();
    expect(report.body.services).toEqual([
      { id: "d1", ok: true },
      { id: "durable_objects", ok: true },
      { id: "queues", ok: true },
      { id: "r2", ok: true },
      { id: "better_auth_secret", ok: true },
      { id: "token_hash_key", ok: true },
    ]);
  });

  it("raw errors go to the Worker log only, never a secret value", async () => {
    await status(new Browser(), { FILES: throwingR2 });
    expect(clock.lines.some((l) => l.includes("setup service check failed") && l.includes('"service":"r2"'))).toBe(
      true,
    );
    for (const line of clock.lines) {
      expect(line).not.toContain(env.TOKEN_HASH_KEY!);
      expect(line).not.toContain(env.BETTER_AUTH_SECRET!);
    }
  });
});
