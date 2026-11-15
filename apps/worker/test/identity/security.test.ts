import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { isAllowedAuthRoute, normalisePath } from "../../src/features/identity/allowlist";
import { consumeRateLimit } from "../../src/features/identity/rate-limits";
import { stripTokens } from "../../src/features/identity/token-filter";
import { SoftAuthenticator } from "./authenticator";
import {
  addMember,
  Browser,
  ORIGIN,
  reauth,
  registerPasskey,
  sessionTokens,
  setupWorkspace,
  signInWithPasskey,
  type Workspace,
} from "./helpers";

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
});

describe("the default-deny allowlist on /api/auth/* (Identity §4.4, §6; TDD §8.1)", () => {
  const blocked: [string, string][] = [
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/sign-in/email"],
    ["GET", "/api/auth/magic-link/verify?token=x"],
    ["POST", "/api/auth/sign-in/magic-link"],
    ["GET", "/api/auth/list-sessions"],
    ["POST", "/api/auth/revoke-session"],
    ["POST", "/api/auth/revoke-sessions"],
    ["POST", "/api/auth/revoke-other-sessions"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/change-email"],
    ["POST", "/api/auth/delete-user"],
    ["GET", "/api/auth/passkey/list-user-passkeys"],
    ["POST", "/api/auth/passkey/delete-passkey"],
    ["POST", "/api/auth/passkey/update-passkey"],
    ["GET", "/api/auth/ok"],
    // Path tricks on allowed routes.
    ["POST", "/api/auth//sign-out"],
    ["POST", "/api/auth/sign-out/"],
    ["POST", "/api/auth/SIGN-OUT"],
    ["POST", "/api/auth/Sign-Out"],
    ["POST", "/api/auth/%73ign-out"],
    ["POST", "/api/auth/passkey%2fverify-authentication"],
    // The URL parser resolves %2e segments before the Worker sees the path: these become get-session
    // and delete-passkey, which are blocked.
    ["GET", "/api/auth/passkey/%2e%2e/get-session"],
    ["POST", "/api/auth/passkey/%2e/delete-passkey"],
    ["GET", "/api/auth/%2E%2E/auth/get-session"],
    ["GET", "/api/auth/get%2dsession"],
    // Methods not listed.
    ["HEAD", "/api/auth/passkey/generate-authenticate-options"],
    ["OPTIONS", "/api/auth/passkey/generate-authenticate-options"],
    ["OPTIONS", "/api/auth/sign-out"],
    ["GET", "/api/auth/sign-out"],
    ["GET", "/api/auth/passkey/verify-authentication"],
    ["POST", "/api/auth/passkey/generate-authenticate-options"],
    ["PUT", "/api/auth/passkey/verify-registration"],
  ];

  for (const [method, path] of blocked) {
    it(`${method} ${path} → 404, with no CORS headers`, async () => {
      const response = await ws.browser.call(path, {
        method,
        ...(method === "GET" || method === "HEAD" ? {} : { body: {} }),
        headers: { "access-control-request-method": "POST" },
      });
      expect(response.status).toBe(404);
      for (const [name] of response.headers) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    });
  }

  it("%2e segments resolve to the route they name, never to another one", () => {
    expect(new URL(`${ORIGIN}/api/auth/passkey/x/%2e%2e/verify-authentication`).pathname).toBe(
      "/api/auth/passkey/verify-authentication",
    );
  });

  it("the matcher: exact normalised method and path only", () => {
    expect(isAllowedAuthRoute("POST", "/api/auth/sign-out")).toBe(true);
    expect(isAllowedAuthRoute("GET", "/api/auth/passkey/generate-register-options")).toBe(true);
    expect(isAllowedAuthRoute("POST", "/api/auth//sign-out")).toBe(false);
    expect(normalisePath("/a/%2e%2e/b")).toBeNull();
    expect(normalisePath("/a\\b")).toBeNull();
    expect(normalisePath("/a/%zz")).toBeNull();
  });

  it("no /api response sends CORS headers, even to a cross-origin preflight", async () => {
    for (const path of ["/api/me", "/api/setup", "/api/auth/passkey/generate-authenticate-options"]) {
      const response = await new Browser().call(path, {
        method: "OPTIONS",
        noCsrf: true,
        headers: { origin: "https://evil.test", "access-control-request-method": "POST" },
      });
      for (const [name] of response.headers) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    }
  });
});

describe("CSRF on our routes and better-auth's (Identity §4.5; TDD §8.2)", () => {
  const stateChanging: [string, string][] = [
    ["POST", "/api/auth/sign-out"],
    ["POST", "/api/auth/passkey/verify-authentication"],
    ["POST", "/api/auth/passkey/verify-registration"],
    ["POST", "/api/setup"],
    ["POST", "/api/me/reauth"],
    ["POST", "/api/me/sessions/sign-out-everywhere"],
  ];
  for (const [method, path] of stateChanging) {
    it(`${method} ${path}: refused without the header, and with another Origin`, async () => {
      const missing = await ws.browser.json(path, { method, body: {}, headers: { origin: ORIGIN }, noCsrf: true });
      expect(missing.status).toBe(403);
      expect(missing.body).toMatchObject({ error: { code: "csrf_failed" } });
      const wrongOrigin = await ws.browser.json(path, { method, body: {}, origin: "https://evil.test" });
      expect(wrongOrigin.body).toMatchObject({ error: { code: "csrf_failed" } });
    });
  }

  it("the two GET options routes need the header too (they write a challenge)", async () => {
    for (const path of [
      "/api/auth/passkey/generate-authenticate-options",
      "/api/auth/passkey/generate-register-options",
    ]) {
      const result = await new Browser().json(path, { noCsrf: true });
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "csrf_failed" } });
    }
  });

  it("sign-out without the header leaves the session working", async () => {
    const member = await addMember();
    await member.browser.call("/api/auth/sign-out", { body: {}, noCsrf: true });
    expect((await member.browser.call("/api/me")).status).toBe(200);
  });
});

describe("the canonical origin (Identity §2, §4.4)", () => {
  it("refuses auth routes on an unknown host", async () => {
    const result = await new Browser().json("/api/auth/passkey/generate-authenticate-options", {
      baseUrl: "https://other.test",
      origin: "https://other.test",
    });
    expect(result.status).toBe(404);
    expect((await new Browser().json("/api/me", { baseUrl: "https://other.test" })).status).toBe(404);
  });

  it("redirects an allowed host to the canonical origin (302 for GET, 307 otherwise), built from the record", async () => {
    await env.DB.prepare("UPDATE installation SET allowed_hosts = ?")
      .bind(JSON.stringify(["officebox.test", "old.test"]))
      .run();
    try {
      const get = await new Browser().call("/api/me?x=1", {
        baseUrl: "https://old.test",
        headers: { host: "evil.test" },
      });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe(`${ORIGIN}/api/me?x=1`);
      expect(get.headers.get("cache-control")).toBe("no-store");
      const post = await new Browser().call("/api/auth/sign-out", { baseUrl: "https://old.test", body: {} });
      expect(post.status).toBe(307);
      expect(post.headers.get("location")).toBe(`${ORIGIN}/api/auth/sign-out`);
    } finally {
      await env.DB.prepare("UPDATE installation SET allowed_hosts = ?")
        .bind(JSON.stringify(["officebox.test"]))
        .run();
    }
  });

  it("the relying-party ID and the expected origin come from the record, whatever Host says", async () => {
    const options = await new Browser().json<{ rpId: string }>("/api/auth/passkey/generate-authenticate-options", {
      headers: { host: "evil.test", "x-forwarded-host": "evil.test" },
    });
    expect(options.body.rpId).toBe("officebox.test");
  });
});

describe("no response body or log line contains a session token (required test; Identity §4.5)", () => {
  it("sweeps a whole flow: sign-in, registration, step-up, devices, sign-out", async () => {
    const lines: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    console.info = capture;
    const browsers: Browser[] = [];
    try {
      const member = await addMember();
      browsers.push(member.browser);
      const a = new Browser();
      browsers.push(a);
      await signInWithPasskey(a, member.authenticator);
      await signInWithPasskey(new Browser(), member.authenticator, { uv: false });
      await reauth(a, member.authenticator);
      await registerPasskey(a, new SoftAuthenticator(), {}, { createSession: true });
      await a.json("/api/me");
      await a.json("/api/me/sessions");
      await a.json("/api/me/passkeys");
      await a.json("/api/me/security-notices");
      await a.json("/api/me/reauth/options", { body: {} });
      await member.browser.json("/api/me/sessions/sign-out-others", { body: {} });
      await a.json("/api/auth/sign-out", { body: {} });
      await ws.browser.json("/api/me");
      await ws.browser.json("/api/auth/get-session");
    } finally {
      Object.assign(console, originals);
    }
    const tokens = await sessionTokens();
    const { results } = await env.DB.prepare("SELECT token FROM sessions").all<{ token: string }>();
    expect(tokens.length).toBe(results.length);
    const bodies = browsers.flatMap((b) => b.bodies).concat(ws.browser.bodies);
    expect(bodies.length).toBeGreaterThan(10);
    // Every token issued during the run, including ones since revoked, was in a cookie only.
    const issued = new Set<string>(tokens);
    for (const b of browsers) {
      const value = b.cookies.get("__Host-officebox.session_token");
      if (value) issued.add(decodeURIComponent(value).split(".")[0]!);
    }
    for (const token of issued) {
      for (const body of bodies) expect(body).not.toContain(token);
      for (const line of lines) expect(line).not.toContain(token);
    }
  });

  it("the filter drops token keys and token-valued strings at any depth", () => {
    const tokens = new Set(["SECRETTOKEN123"]);
    expect(
      stripTokens(
        { token: "a", session: { token: "b", id: "s", copy: "SECRETTOKEN123" }, list: ["SECRETTOKEN123", "ok"] },
        tokens,
      ),
    ).toEqual({ session: { id: "s" }, list: ["ok"] });
  });
});

describe("rate limits before better-auth (Platform §8)", () => {
  it("passkey sign-in: 20 per minute per IP, then rate_limited", async () => {
    const browser = new Browser();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push((await browser.call("/api/auth/passkey/generate-authenticate-options")).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("better-auth's backstop storage consumes atomically: 20 concurrent calls with max 5 allow exactly 5", async () => {
    const key = `test-${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(env.DB, key, { window: 60, max: 5 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed).every((r) => (r.retryAfter ?? 0) >= 1)).toBe(true);
  });

  it("the D1 reauth counter is atomic under concurrency", async () => {
    const member = await addMember();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        member.browser.json("/api/me/reauth", { body: { response: { id: "x", type: "public-key" } } }),
      ),
    );
    expect(results.filter((r) => r.status !== 429)).toHaveLength(5);
  });
});

describe("emails are normalised (Identity §4.4, §5)", () => {
  it("two emails differing only in case or Unicode form share one normalised address, which is unique", async () => {
    const member = await addMember();
    const variant = member.email.toUpperCase().replace("@", "＠"); // fullwidth @ normalises (NFKC) to @
    const { normaliseEmail } = await import("@officebox/shared");
    expect(normaliseEmail(variant)).toBe(member.email);
    await expect(
      env.DB.prepare(
        "INSERT INTO users (id, email, email_normalised, display_name, created_at, updated_at) VALUES ('01JXDUPLICATE0000000000000', ?, ?, 'x', 0, 0)",
      )
        .bind(variant, normaliseEmail(variant))
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});
