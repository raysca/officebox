import { setupStatusSchema } from "@officebox/shared";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_TTL_MS } from "../../src/features/identity/setup-token";
import { Clock, CookieJar, errorCode, makeApp, resetInstallation, uniqueIp } from "./helpers";

/**
 * First-run setup (Identity §4.1, §9 "Setup (M1)"; TDD §6.8). Setup is a singleton per installation,
 * so every test starts from a fresh deploy (no installation row, no users).
 */

const SECRET = "s".repeat(40);

function body(token: string, overrides: Record<string, unknown> = {}) {
  return {
    token,
    workspaceName: "Acme",
    ownerName: "Sam Lee",
    ownerHandle: "sam",
    ownerEmail: `owner-${crypto.randomUUID().slice(0, 8)}@example.com`,
    password: "correct horse battery",
    ...overrides,
  };
}

/** Captures the generated token from the unredacted log line. */
function captureLoggedTokens() {
  const tokens: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    if (typeof line !== "string") return;
    try {
      const record = JSON.parse(line) as { message?: string; setupToken?: string; unredacted?: boolean };
      if (record.message === "officebox setup token" && record.unredacted && record.setupToken) {
        tokens.push(record.setupToken);
      }
    } catch {
      // Not ours.
    }
  });
  return { tokens, spy };
}

async function count(sql: string): Promise<number> {
  return (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

beforeEach(async () => {
  await resetInstallation();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generated setup token", () => {
  it("is generated on the first visit, logged once, and stored only as a hash", async () => {
    const { tokens } = captureLoggedTokens();
    const { call } = makeApp();
    const res = await call("GET", "/api/setup");
    expect(res.status).toBe(200);
    expect(setupStatusSchema.parse(await res.json())).toEqual({ setupRequired: true, tokenSource: "generated" });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await env.DB.prepare("SELECT setup_token_hash, setup_completed_at FROM installation").first<{
      setup_token_hash: string;
      setup_completed_at: number | null;
    }>();
    expect(row?.setup_token_hash).toBeTruthy();
    expect(row?.setup_token_hash).not.toContain(tokens[0]);
    expect(row?.setup_completed_at).toBeNull();

    // Further visits reuse it without logging again.
    await call("GET", "/api/setup");
    expect(tokens).toHaveLength(1);
  });

  it("concurrent first visits produce a single token", async () => {
    const { tokens } = captureLoggedTokens();
    const { call } = makeApp();
    await Promise.all(Array.from({ length: 5 }, () => call("GET", "/api/setup")));
    expect(tokens).toHaveLength(1);
  });

  it("is replaced and logged again once expired, and the old one stops working", async () => {
    const { tokens } = captureLoggedTokens();
    const clock = new Clock();
    const { call } = makeApp(clock);
    await call("GET", "/api/setup");
    clock.advance(SETUP_TOKEN_TTL_MS + 1);
    await call("GET", "/api/setup");
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).not.toBe(tokens[0]);

    const stale = await call("POST", "/api/setup", body(tokens[0] ?? ""));
    expect(stale.status).toBe(403);
    const fresh = await call("POST", "/api/setup", body(tokens[1] ?? ""));
    expect(fresh.status).toBe(201);
  });
});

describe("POST /api/setup", () => {
  async function generatedToken(call: ReturnType<typeof makeApp>["call"]): Promise<string> {
    const { tokens } = captureLoggedTokens();
    await call("GET", "/api/setup");
    const token = tokens[0];
    if (!token) throw new Error("no token logged");
    return token;
  }

  it("can't be claimed without the token", async () => {
    const { call } = makeApp();
    await generatedToken(call);
    const res = await call("POST", "/api/setup", body("wrong-token"));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
    expect(await count("SELECT COUNT(*) AS n FROM users")).toBe(0);
  });

  it("creates the owner with a handle, the workspace name and an audit entry, and nothing of later milestones", async () => {
    const { call } = makeApp();
    const token = await generatedToken(call);
    const request = body(token, { ownerEmail: "  Owner@Example.COM ", ownerHandle: "Sam.Lee" });
    const res = await call("POST", "/api/setup", request);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ownerEmail: "owner@example.com" });

    const owner = await env.DB.prepare(
      "SELECT id, email, display_name, handle, role, status, password_hash, session_epoch FROM users",
    ).first<Record<string, string | number>>();
    expect(owner).toMatchObject({
      email: "owner@example.com",
      display_name: "Sam Lee",
      handle: "sam.lee",
      role: "owner",
      status: "active",
      session_epoch: 0,
    });
    expect(String(owner?.password_hash)).toMatch(
      /^pbkdf2-sha256-hmac\$1\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
    );

    const handle = await env.DB.prepare("SELECT owner_type, owner_id FROM handles WHERE handle = 'sam.lee'").first();
    expect(handle).toEqual({ owner_type: "user", owner_id: owner?.id });

    const installation = await env.DB.prepare(
      "SELECT name, setup_token_hash, setup_claim, setup_completed_at, settings FROM installation",
    ).first<Record<string, unknown>>();
    expect(installation).toMatchObject({ name: "Acme", setup_token_hash: null, settings: "{}" });
    expect(installation?.setup_claim).toBeTruthy();
    expect(installation?.setup_completed_at).toBeTypeOf("number");

    const audit = await env.DB.prepare(
      "SELECT actor_id, target_type, target_id, metadata FROM audit_log WHERE action = 'setup.complete' AND actor_id = ?",
    )
      .bind(owner?.id ?? "")
      .all();
    expect(audit.results).toEqual([
      { actor_id: owner?.id, target_type: "user", target_id: owner?.id, metadata: '{"setupVia":"generated"}' },
    ]);

    // Identity objects only (Identity §4.1): no channel, calendar or drive tables exist in M1.
    const later = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channels', 'calendars', 'drives', 'channel_members')",
    ).all();
    expect(later.results).toEqual([]);
  });

  it("can only be claimed once: afterwards /api/setup is 404 for GET and POST", async () => {
    const { call } = makeApp();
    const token = await generatedToken(call);
    expect((await call("POST", "/api/setup", body(token))).status).toBe(201);

    expect((await call("GET", "/api/setup")).status).toBe(404);
    const second = await call("POST", "/api/setup", body(token, { ownerEmail: "intruder@example.com" }));
    expect(second.status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM users")).toBe(1);
  });

  it("lets exactly one of several concurrent claims win", async () => {
    const { call } = makeApp();
    const token = await generatedToken(call);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => call("POST", "/api/setup", body(token, { ownerHandle: `owner${i}` }))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 404, 404, 404]);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM handles")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'setup.complete'")).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("refuses weak passwords, reserved handles and unknown fields with field errors", async () => {
    const { call } = makeApp();
    const token = await generatedToken(call);
    const weak = await call("POST", "/api/setup", body(token, { password: "password123" }));
    expect(weak.status).toBe(400);
    const weakBody: { error: { code: string; fields: Record<string, string[]> } } = await weak.json();
    expect(weakBody.error.code).toBe("validation_failed");
    expect(Object.keys(weakBody.error.fields)).toEqual(["password"]);

    const reserved = await call("POST", "/api/setup", body(token, { ownerHandle: "admin" }));
    expect(reserved.status).toBe(400);
    const extra = await call("POST", "/api/setup", { ...body(token), role: "admin" });
    expect(extra.status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM users")).toBe(0);
  });

  it("is rate-limited per IP: the 6th attempt in a minute is refused", async () => {
    const { call } = makeApp();
    await generatedToken(call);
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call("POST", "/api/setup", body("wrong"), { ip })).status);
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
  });

  it("refuses requests without the CSRF header or with a foreign Origin", async () => {
    const { call } = makeApp();
    const token = await generatedToken(call);
    const noHeader = await call("POST", "/api/setup", body(token), { csrf: false });
    expect(noHeader.status).toBe(403);
    expect(await errorCode(noHeader)).toBe("csrf_failed");
    const foreign = await call("POST", "/api/setup", body(token), { origin: "https://evil.example" });
    expect(await errorCode(foreign)).toBe("csrf_failed");
    const noOrigin = await call("POST", "/api/setup", body(token), { origin: null });
    expect(await errorCode(noOrigin)).toBe("csrf_failed");
    expect(await count("SELECT COUNT(*) AS n FROM users")).toBe(0);
  });

  it("answers unavailable when the identity secrets are missing", async () => {
    const { call } = makeApp();
    const token = await generatedToken(call);
    const res = await call("POST", "/api/setup", body(token), { env: { ...env, PEPPER_1: undefined } });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("unavailable");
  });
});

describe("SETUP_TOKEN secret", () => {
  it("is used instead of a generated token, and nothing is logged", async () => {
    const { tokens } = captureLoggedTokens();
    const { call } = makeApp();
    const withSecret = { ...env, SETUP_TOKEN: SECRET };
    const status = await call("GET", "/api/setup", undefined, { env: withSecret });
    expect(await status.json()).toEqual({ setupRequired: true, tokenSource: "secret" });
    expect(tokens).toEqual([]);

    expect((await call("POST", "/api/setup", body("x".repeat(40)), { env: withSecret })).status).toBe(403);
    expect((await call("POST", "/api/setup", body(SECRET), { env: withSecret })).status).toBe(201);
    const audit = await env.DB.prepare(
      "SELECT a.metadata FROM audit_log a JOIN users u ON u.id = a.actor_id WHERE a.action = 'setup.complete'",
    ).first();
    expect(audit).toEqual({ metadata: '{"setupVia":"secret"}' });
  });

  it("an empty secret counts as unset (generated mode)", async () => {
    const { tokens } = captureLoggedTokens();
    const { call } = makeApp();
    const res = await call("GET", "/api/setup", undefined, { env: { ...env, SETUP_TOKEN: "" } });
    expect(await res.json()).toEqual({ setupRequired: true, tokenSource: "generated" });
    expect(tokens).toHaveLength(1);
  });

  it("a secret shorter than 32 characters disables setup", async () => {
    const { call } = makeApp();
    const res = await call("POST", "/api/setup", body("short"), { env: { ...env, SETUP_TOKEN: "short" } });
    expect(res.status).toBe(503);
  });
});

describe("before setup", () => {
  it("authenticated routes answer setup_required, so the web app goes to /setup", async () => {
    const { call } = makeApp();
    const me = await call("GET", "/api/me");
    expect(me.status).toBe(409);
    expect(await errorCode(me)).toBe("setup_required");

    const signIn = await call("POST", "/api/auth/password", { email: "a@example.com", password: "whatever-pw" });
    expect(await errorCode(signIn)).toBe("setup_required");
  });

  it("sign-in works for the owner right after setup", async () => {
    const { call } = makeApp();
    const { tokens } = captureLoggedTokens();
    await call("GET", "/api/setup");
    const request = body(tokens[0] ?? "");
    expect((await call("POST", "/api/setup", request)).status).toBe(201);
    const jar = new CookieJar();
    const res = await call(
      "POST",
      "/api/auth/password",
      { email: request.ownerEmail, password: request.password },
      { jar },
    );
    expect(res.status).toBe(200);
    const me = await call("GET", "/api/me", undefined, { jar });
    expect(await me.json()).toMatchObject({ user: { role: "owner", handle: "sam" }, workspace: { name: "Acme" } });
  });
});
