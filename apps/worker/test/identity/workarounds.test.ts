import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/core/log";
import { AUTH_ALLOWLIST } from "../../src/features/identity/allowlist";
import { buildAuthOptions, createAuth, SESSION_COOKIE } from "../../src/features/identity/auth";
import { createKysely } from "../../src/features/identity/d1-kysely";
import { runWithStore } from "../../src/features/identity/request-store";
import { identitySecrets } from "../../src/features/identity/secrets";
import { SoftAuthenticator } from "./authenticator";
import {
  addMember,
  Browser,
  giveTicket,
  ORIGIN,
  reauth,
  registerPasskey,
  setupWorkspace,
  signInWithPasskey,
  staleFreshAuth,
  uniqueEmail,
  type Workspace,
} from "./helpers";

/**
 * One test per M1a-0 spike workaround (spikes/better-auth/README.md, "Workarounds M1a must carry"), so
 * a better-auth upgrade can't silently break one. Several are also covered in depth elsewhere; each is
 * proven here on its own.
 */

const silent = createLogger({}, () => {});
const INSTALLATION = { canonicalOrigin: ORIGIN, workspaceName: "Acme Studio" };
async function secrets() {
  const result = await identitySecrets(env, silent);
  if (!result.ok) throw new Error("test secrets missing");
  return result.value;
}
const count = async (sql: string, ...params: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
});

describe("workaround 1: epoch-ms dates through our Kysely plugin", () => {
  it("better-auth's date columns are stored as INTEGER epoch ms and still read back as dates", async () => {
    const member = await addMember();
    for (const [table, column] of [
      ["sessions", "expires_at"],
      ["sessions", "created_at"],
      ["sessions", "updated_at"],
      ["users", "created_at"],
      ["passkeys", "created_at"],
    ] as const) {
      const row = await env.DB.prepare(
        `SELECT typeof(${column}) AS t FROM ${table} WHERE ${table === "users" ? "id" : "user_id"} = ?`,
      )
        .bind(member.id)
        .first<{ t: string }>();
      expect(row?.t, `${table}.${column}`).toBe("integer");
    }
    // better-auth reads them back as dates: the session works.
    expect((await member.browser.call("/api/me")).status).toBe(200);
  });

  it("ISO-looking text outside the date columns is left alone", async () => {
    const db = createKysely(env.DB);
    const iso = "2026-11-15T10:00:00.000Z";
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS epoch_probe (id TEXT PRIMARY KEY, note TEXT, created_at INTEGER)",
    ).run();
    const id = crypto.randomUUID();
    await db
      .insertInto("epoch_probe" as never)
      .values({ id, note: iso, created_at: iso })
      .execute();
    const raw = await env.DB.prepare("SELECT note, created_at FROM epoch_probe WHERE id = ?")
      .bind(id)
      .first<{ note: string; created_at: number }>();
    expect(raw).toEqual({ note: iso, created_at: Date.parse(iso) });
    const read = await db
      .selectFrom("epoch_probe" as never)
      .selectAll()
      .where("id" as never, "=", id as never)
      .executeTakeFirst();
    expect(read).toMatchObject({ note: iso, created_at: iso });
  });
});

describe("workaround 2: user verification enforced by our hooks", () => {
  it("registration options require UV and a resident key; authentication options are rewritten to required", async () => {
    const browser = new Browser();
    await giveTicket(browser, (await addMember()).id);
    const reg = await browser.json<{ authenticatorSelection: { userVerification: string; residentKey: string } }>(
      "/api/auth/passkey/generate-register-options",
    );
    expect(reg.body.authenticatorSelection).toMatchObject({ userVerification: "required", residentKey: "required" });
    const auth = await new Browser().json<{ userVerification: string }>(
      "/api/auth/passkey/generate-authenticate-options",
    );
    expect(auth.body.userVerification).toBe("required");
  });

  it("an attestation without the UV flag is refused at registration, and an assertion without it at sign-in", async () => {
    const member = await addMember();
    const browser = new Browser();
    await giveTicket(browser, member.id);
    expect((await registerPasskey(browser, new SoftAuthenticator({ uv: false }))).verify?.body).toMatchObject({
      error: { reason: "USER_VERIFICATION_REQUIRED" },
    });
    expect((await signInWithPasskey(new Browser(), member.authenticator, { uv: false })).verify.body).toMatchObject({
      error: { reason: "USER_VERIFICATION_REQUIRED" },
    });
  });
});

describe("workaround 3: the passkey origin and rpID are set from the installation record", () => {
  it("a request's Origin header doesn't become the expected origin", async () => {
    const auth = createAuth(env, await secrets(), INSTALLATION);
    const store = { log: silent };
    await runWithStore(store, async () => {
      const options = await auth.api.generatePasskeyAuthenticationOptions({
        headers: new Headers(),
        returnHeaders: true,
      });
      const cookie = options.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      const response = await ws.authenticator.authenticate(options.response, "https://evil.test");
      const result = await auth.api
        .verifyPasskeyAuthentication({
          body: { response },
          headers: new Headers({ cookie, origin: "https://evil.test" }),
        })
        .then(() => "signed in")
        .catch(() => "refused");
      expect(result).toBe("refused");

      // Positive control: the same in-process flow with the canonical origin signs in.
      const fresh = await auth.api.generatePasskeyAuthenticationOptions({
        headers: new Headers(),
        returnHeaders: true,
      });
      const freshCookie = fresh.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      const good = await ws.authenticator.authenticate(fresh.response, ORIGIN);
      const accepted = await auth.api
        .verifyPasskeyAuthentication({
          body: { response: good },
          headers: new Headers({ cookie: freshCookie, origin: ORIGIN }),
        })
        .then(() => "signed in")
        .catch(() => "refused");
      expect(accepted).toBe("signed in");
    });
    const options = buildAuthOptions(env, await secrets(), INSTALLATION);
    expect(options.baseURL).toBe(ORIGIN);
    expect(options.trustedOrigins).toEqual([ORIGIN]);
  });
});

describe("workaround 4: clone detection by re-verifying the refused assertion", () => {
  it("a genuine assertion with a regressed counter is clone_detected; the stored counter is unchanged", async () => {
    const member = await addMember();
    await signInWithPasskey(new Browser(), member.authenticator);
    const sessions = await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", member.id);
    const stored = await count("SELECT sign_count AS n FROM passkeys WHERE user_id = ?", member.id);
    const { verify } = await signInWithPasskey(new Browser(), member.authenticator, { counter: 1 });
    expect(verify.body).toMatchObject({ error: { reason: "clone_detected" } });
    expect(await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", member.id)).toBe(sessions);
    expect(await count("SELECT sign_count AS n FROM passkeys WHERE user_id = ?", member.id)).toBe(stored);
  });
});

describe("workaround 5: createSession forced for ticket registrations, stripped when signed in", () => {
  it("a ticket registration signs the person in even without createSession in the body", async () => {
    const member = await addMember();
    const browser = new Browser();
    await giveTicket(browser, member.id);
    const reg = await registerPasskey(browser, new SoftAuthenticator(), {}, {});
    expect(reg.verify?.status).toBe(200);
    expect(browser.sessionCookie).toBeTruthy();
  });

  it("a signed-in registration asking for createSession gets no second session", async () => {
    const member = await addMember();
    const before = await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", member.id);
    await registerPasskey(member.browser, new SoftAuthenticator(), {}, { createSession: true });
    expect(await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", member.id)).toBe(before);
  });
});

describe("workaround 6: the enrolment ticket is read at options and consumed at verify, before any write", () => {
  it("a consumed ticket can't register a second passkey", async () => {
    const member = await addMember();
    const browser = new Browser();
    const ticket = await giveTicket(browser, member.id);
    await registerPasskey(browser, new SoftAuthenticator());
    const replay = new Browser();
    replay.cookies.set("__Host-officebox-enrol", ticket.token);
    const before = await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", member.id);
    expect((await registerPasskey(replay, new SoftAuthenticator())).options.status).toBe(403);
    expect(await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", member.id)).toBe(before);
  });
});

describe("workaround 7: the token filter on the better-auth mount", () => {
  it("better-auth's own verify body carries the session token; ours never does", async () => {
    const auth = createAuth(env, await secrets(), INSTALLATION);
    const browser = new Browser();
    const options = await browser.json<{ challenge: string }>("/api/auth/passkey/generate-authenticate-options");
    const response = await ws.authenticator.authenticate(options.body, ORIGIN);
    // Straight to better-auth's handler (no filter): the library includes the token.
    const raw = await runWithStore({ log: silent }, () =>
      auth.handler(
        new Request(`${ORIGIN}/api/auth/passkey/verify-authentication`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: browser.cookieHeader(), origin: ORIGIN },
          body: JSON.stringify({ response }),
        }),
      ),
    );
    const rawBody = await raw.json<{ session?: { token?: string } }>();
    expect(typeof rawBody.session?.token).toBe("string");
    // Through our mount: no token anywhere in the body.
    const ours = await signInWithPasskey(new Browser(), ws.authenticator);
    expect(ours.verify.status).toBe(200);
    expect(JSON.stringify(ours.verify.body)).not.toMatch(/"token"/);
  });
});

describe("workaround 8: __Host- cookies", () => {
  it("the session and challenge cookies are __Host- prefixed, Secure, Path=/ and host-only", async () => {
    const browser = new Browser();
    const options = await browser.call("/api/auth/passkey/generate-authenticate-options");
    const challenge = options.headers.getSetCookie()[0]!;
    expect(challenge).toMatch(/^__Host-officebox\.better-auth-passkey=/);
    expect(challenge).toMatch(/; Secure/);
    expect(challenge).toMatch(/; Path=\//);
    expect(challenge).not.toMatch(/Domain=/i);
    await signInWithPasskey(browser, ws.authenticator);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(true);
    expect([...browser.cookies.keys()].some((k) => k.startsWith("__Secure-"))).toBe(false);
  });
});

describe("workaround 9: the CSRF header on the two GET options routes", () => {
  it("is required even though they are GETs", async () => {
    const result = await new Browser().json("/api/auth/passkey/generate-authenticate-options", { noCsrf: true });
    expect(result.body).toMatchObject({ error: { code: "csrf_failed" } });
  });
});

describe("workaround 10: the server-set marker through AsyncLocalStorage", () => {
  it("internalAdapter.createUser without the marker is refused; with it the user is created and tagged", async () => {
    const internal = (await createAuth(env, await secrets(), INSTALLATION).$context).internalAdapter;
    const refusedEmail = uniqueEmail("nomarker");
    const refused = await runWithStore({ log: silent }, () =>
      internal.createUser({ email: refusedEmail, name: "x", emailVerified: true }, { method: "test" }),
    );
    expect(refused).toBeNull();
    expect(await count("SELECT count(*) AS n FROM users WHERE email = ?", refusedEmail)).toBe(0);
    // Outside any request store too.
    expect(
      await internal.createUser({ email: uniqueEmail("nostore"), name: "x", emailVerified: true }, { method: "test" }),
    ).toBeNull();

    const email = uniqueEmail("marker");
    const created = await runWithStore(
      { log: silent, create: { kind: "setup", attemptId: "01JATTEMPT0000000000000000", role: "member", handle: "h" } },
      () => internal.createUser({ email, name: "x", emailVerified: true }, { method: "test" }),
    );
    expect(created?.id).toBeTruthy();
    const row = await env.DB.prepare("SELECT created_attempt_id, email_normalised FROM users WHERE email = ?")
      .bind(email)
      .first<{ created_attempt_id: string; email_normalised: string }>();
    expect(row).toEqual({ created_attempt_id: "01JATTEMPT0000000000000000", email_normalised: email });
  });

  it("createOAuthUser and signUpEmail are refused without the marker, even with a pending invitation", async () => {
    const auth = createAuth(env, await secrets(), INSTALLATION);
    const internal = (await auth.$context).internalAdapter;
    const email = uniqueEmail("oauth");
    await runWithStore({ log: silent }, () =>
      internal
        .createOAuthUser({ email, name: "x", emailVerified: true }, { accountId: "a", providerId: "p" })
        .catch(() => null),
    );
    expect(await count("SELECT count(*) AS n FROM users WHERE email = ?", email)).toBe(0);
    const signUp = uniqueEmail("signup");
    await expect(
      runWithStore({ log: silent }, () =>
        auth.api.signUpEmail({
          body: { email: signUp, password: "correct horse battery staple", name: "x" },
          headers: new Headers(),
        }),
      ),
    ).rejects.toBeTruthy();
    expect(await count("SELECT count(*) AS n FROM users WHERE email = ?", signUp)).toBe(0);
    // Over HTTP the route isn't even reachable, and no header can set the marker.
    const http = await new Browser().json("/api/auth/sign-up/email", {
      body: { email: signUp, password: "correct horse battery staple", name: "x" },
      headers: { "x-officebox-marker": "setup" },
    });
    expect(http.status).toBe(404);
  });
});

describe("workaround 11: step-up vetoes the session in a reauth context", () => {
  it("re-authenticating moves fresh_auth_at and leaves the session count unchanged", async () => {
    const member = await addMember();
    await staleFreshAuth(member.id);
    const before = await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", member.id);
    expect((await reauth(member.browser, member.authenticator)).status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", member.id)).toBe(before);
  });
});

describe("workaround 12: getSession's Set-Cookie is forwarded", () => {
  it("a read after a day re-issues the session cookie through GET /me", async () => {
    const member = await addMember();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start + 25 * 60 * 60 * 1000);
      const response = await member.browser.call("/api/me");
      expect(response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("workaround 13: users are created with emailVerified true", () => {
  it("the setup owner is verified", async () => {
    expect(await count("SELECT email_verified AS n FROM users WHERE id = ?", ws.ownerId)).toBe(1);
  });
});

describe("workaround 14: explicit options", () => {
  it("rate limiting is on with D1 storage, telemetry off, joins on, the cookie cache off", async () => {
    const options = buildAuthOptions(env, await secrets(), INSTALLATION);
    expect(options.rateLimit.enabled).toBe(true);
    expect(typeof options.rateLimit.customStorage.consume).toBe("function");
    expect(options.telemetry.enabled).toBe(false);
    expect(options.advanced.database.joins).toBe(true);
    expect(options.session.cookieCache.enabled).toBe(false);
    // The backstop writes to rate_counters (scope better_auth), never to memory.
    await new Browser().call("/api/auth/passkey/generate-authenticate-options");
    expect(await count("SELECT count(*) AS n FROM rate_counters WHERE scope = 'better_auth'")).toBeGreaterThan(0);
  });

  it("AsyncLocalStorage is available (nodejs_compat)", async () => {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const als = new AsyncLocalStorage<number>();
    expect(als.run(7, () => als.getStore())).toBe(7);
  });
});

describe("workaround 15: rotating BETTER_AUTH_SECRET signs everyone out (documented in Platform §16)", () => {
  it("a cookie signed with the old secret stops verifying once a new secret is first in the list", async () => {
    const member = await addMember();
    const old = env.BETTER_AUTH_SECRET!;
    const rotated = `2:rotated-secret-0123456789abcdefghijklmnop,1:${old}`;
    expect((await member.browser.call("/api/me", { env: { BETTER_AUTH_SECRETS: `1:${old}` } })).status).toBe(200);
    expect((await member.browser.call("/api/me", { env: { BETTER_AUTH_SECRETS: rotated } })).status).toBe(401);
  });

  it("a malformed BETTER_AUTH_SECRETS makes sign-in unavailable rather than guessing", async () => {
    const result = await new Browser().json("/api/me", { env: { BETTER_AUTH_SECRETS: "no-version-here" } });
    expect(result.status).toBe(503);
  });
});

describe("workaround 16: upgrade checks", () => {
  it("only the reviewed better-auth routes are reachable (a new route needs a review to be added)", () => {
    expect([...AUTH_ALLOWLIST].sort()).toEqual(
      [
        "GET /api/auth/passkey/generate-authenticate-options",
        "GET /api/auth/passkey/generate-register-options",
        "POST /api/auth/passkey/verify-authentication",
        "POST /api/auth/passkey/verify-registration",
        // M1b, reviewed: behind our availability check and per-IP and per-email limits (Identity §4.4).
        "POST /api/auth/sign-in/magic-link",
        "POST /api/auth/sign-out",
      ].sort(),
    );
  });
  // The static creation-path scan and the pinned-version check run under Node:
  // test/node/creation-paths.test.ts. The UV and clone end-to-end checks: e2e/tests/passkeys.spec.ts.
});
