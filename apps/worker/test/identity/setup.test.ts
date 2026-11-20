import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/core/log";
import { IDENTITY_JOBS } from "../../src/features/identity/jobs";
import { authFor } from "../../src/features/identity/auth";
import { identitySecrets } from "../../src/features/identity/secrets";
import { expireIfStale, expireStaleClaim, SETUP_CLAIM_TTL_MS } from "../../src/features/identity/setup";
import { completeSetupClaim } from "../../src/features/identity/setup-state";
import { configuredLimit, FakeRateLimit } from "../fake-rate-limit";
import { SoftAuthenticator } from "./authenticator";
import {
  Browser,
  claim,
  ORIGIN,
  ownerDetails,
  registerPasskey,
  resetInstallation,
  seedSetupToken,
  SETUP_TOKEN,
  signInWithPasskey,
} from "./helpers";

const installation = () =>
  env.DB.prepare(
    "SELECT name, setup_claim, setup_claimed_at, setup_completed_at, canonical_origin, allowed_hosts, setup_token_hash FROM installation WHERE id = 1",
  ).first<{
    name: string;
    setup_claim: string | null;
    setup_claimed_at: number | null;
    setup_completed_at: number | null;
    canonical_origin: string | null;
    allowed_hosts: string | null;
    setup_token_hash: string | null;
  }>();
const ownerOf = (email: string) =>
  env.DB.prepare(
    "SELECT id, role, status, handle, email_normalised, email_verified, created_attempt_id FROM users WHERE email = ?",
  )
    .bind(email)
    .first<{
      id: string;
      role: string;
      status: string;
      handle: string;
      email_normalised: string;
      email_verified: number;
      created_attempt_id: string;
    }>();
const silent = createLogger({}, () => {});
const ctx = () => ({ env, log: silent, now: Date.now });

beforeEach(async () => {
  await resetInstallation();
  await seedSetupToken();
});

describe("first-run setup with a passkey (Identity §4.1; TDD §6.8)", () => {
  it("GET /api/setup reports the token source and whether a claim is open", async () => {
    const browser = new Browser();
    const status = await browser.json("/api/setup");
    expect(status.body).toMatchObject({ setupRequired: true, tokenSource: "generated", claimed: false });
  });

  it("refuses a wrong token, and an invalid body, before anything is created", async () => {
    const browser = new Browser();
    const owner = ownerDetails();
    const wrong = await claim(browser, owner, "not-the-token-0123456789abcdefghijklmnop");
    expect(wrong.status).toBe(403);
    const invalid = await browser.json("/api/setup", {
      body: { token: SETUP_TOKEN, workspaceName: "", ownerName: "x", ownerHandle: "!", ownerEmail: "nope" },
    });
    expect(invalid.status).toBe(400);
    expect((await installation())?.setup_claim).toBeNull();
    expect(await ownerOf(owner.email)).toBeNull();
  });

  it("claims: records the canonical origin and allowed hosts, creates the owner and handle, sets a ticket cookie", async () => {
    const browser = new Browser();
    const owner = ownerDetails();
    const result = await claim(browser, owner);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ ownerEmail: owner.email });
    expect((result.body as { enrolmentExpiresInSeconds: number }).enrolmentExpiresInSeconds).toBeGreaterThan(890);
    const row = await installation();
    expect(row?.canonical_origin).toBe(ORIGIN);
    expect(JSON.parse(row!.allowed_hosts!)).toEqual(["officebox.test"]);
    expect(row?.name).toBe(owner.workspace);
    expect(row?.setup_completed_at).toBeNull();
    const user = await ownerOf(owner.email);
    expect(user).toMatchObject({
      role: "owner",
      status: "active",
      handle: owner.handle,
      email_verified: 1,
      created_attempt_id: row!.setup_claim,
    });
    expect(user!.email_normalised).toBe(owner.email.toLowerCase());
    const handle = await env.DB.prepare("SELECT owner_id FROM handles WHERE handle = ?")
      .bind(owner.handle)
      .first<{ owner_id: string }>();
    expect(handle?.owner_id).toBe(user!.id);
    // The ticket is only in the cookie: HttpOnly, Secure, SameSite=Strict, __Host-, Path=/.
    expect(JSON.stringify(result.body)).not.toContain(browser.cookies.get("__Host-officebox-enrol"));
  });

  it("the ticket cookie has the __Host- attributes", async () => {
    const owner = ownerDetails();
    const response = await new Browser().call("/api/setup", {
      body: {
        token: SETUP_TOKEN,
        workspaceName: owner.workspace,
        ownerName: owner.name,
        ownerHandle: owner.handle,
        ownerEmail: owner.email,
      },
    });
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith("__Host-officebox-enrol="))!;
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Strict/);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("setup completes only with the owner's passkey, which signs the owner in; then /api/setup is 404", async () => {
    const browser = new Browser();
    const owner = ownerDetails();
    await claim(browser, owner);
    expect((await installation())?.setup_completed_at).toBeNull();
    const reg = await registerPasskey(browser, new SoftAuthenticator());
    expect(reg.verify?.status).toBe(200);
    const row = await installation();
    expect(row?.setup_completed_at).not.toBeNull();
    expect(row?.setup_token_hash).toBeNull();
    expect(browser.sessionCookie).toBeTruthy();
    const me = await browser.json<{ user: { role: string }; passkeyCount: number }>("/api/me");
    expect(me.body).toMatchObject({ user: { role: "owner" }, passkeyCount: 1 });
    const passkey = await env.DB.prepare("SELECT created_via FROM passkeys").first<{ created_via: string }>();
    expect(passkey?.created_via).toBe("setup");
    expect((await browser.json("/api/setup")).status).toBe(404);
    expect((await claim(new Browser())).status).toBe(404);
    expect((await new Browser().json("/api/setup/resume", { body: { token: SETUP_TOKEN } })).status).toBe(404);
  });

  it("creates identity objects only (nothing from later milestones)", async () => {
    const browser = new Browser();
    await claim(browser);
    await registerPasskey(browser, new SoftAuthenticator());
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
      name: string;
    }>();
    const tables = results.map((r) => r.name);
    for (const later of ["channels", "channel_members", "calendars", "drives", "folders"]) {
      expect(tables).not.toContain(later);
    }
    // Invitations are an identity object (M1b), but setup creates none.
    const invitations = await env.DB.prepare("SELECT count(*) AS n FROM invitations").first<{ n: number }>();
    expect(invitations?.n).toBe(0);
  });

  it("a second claim while one is open is refused (409): resume instead", async () => {
    await claim(new Browser());
    const second = await claim(new Browser(), ownerDetails());
    expect(second.status).toBe(409);
  });

  it("concurrent claims: exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => claim(new Browser(), ownerDetails())));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const owners = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE role = 'owner'").first<{ n: number }>();
    expect(owners?.n).toBe(1);
  });

  it("resume issues a new ticket for the claimed owner only, on any device, until a passkey or session exists", async () => {
    const owner = ownerDetails();
    await claim(new Browser(), owner);
    const other = new Browser();
    const resumed = await other.json("/api/setup/resume", { body: { token: SETUP_TOKEN } });
    expect(resumed.status).toBe(201);
    expect(resumed.body).toMatchObject({ ownerEmail: owner.email });
    expect(other.cookies.get("__Host-officebox-enrol")).toBeTruthy();
    // A wrong token can't resume.
    expect(
      (await new Browser().json("/api/setup/resume", { body: { token: "wrong-token-0123456789abcdefghijklmnopq" } }))
        .status,
    ).toBe(403);
    // Registering on the other device completes setup; resume then answers 410 (setup is 404 once complete).
    await registerPasskey(other, new SoftAuthenticator());
    expect((await new Browser().json("/api/setup/resume", { body: { token: SETUP_TOKEN } })).status).toBe(404);
  });

  it("resume answers 410 once the owner has a passkey even if completion didn't run", async () => {
    const owner = ownerDetails();
    const browser = new Browser();
    await claim(browser, owner);
    await registerPasskey(browser, new SoftAuthenticator());
    // As if the completion hook had failed: still incomplete, the token still stored.
    await env.DB.prepare("UPDATE installation SET setup_completed_at = NULL").run();
    await seedSetupToken();
    const { clearSetupCache } = await import("../../src/features/identity/setup-state");
    clearSetupCache(env.DB);
    const resumed = await new Browser().json("/api/setup/resume", { body: { token: SETUP_TOKEN } });
    expect(resumed.status).toBe(410);
  });

  it("resume answers 410 once the owner has had a session", async () => {
    const owner = ownerDetails();
    await claim(new Browser(), owner);
    await env.DB.prepare("UPDATE users SET first_signed_in_at = ? WHERE email = ?").bind(Date.now(), owner.email).run();
    expect((await new Browser().json("/api/setup/resume", { body: { token: SETUP_TOKEN } })).status).toBe(410);
  });

  it("the claim's generated token stays valid for resume past its own expiry, while the claim is open", async () => {
    await claim(new Browser());
    await env.DB.prepare("UPDATE installation SET setup_token_expires_at = ?")
      .bind(Date.now() - 1000)
      .run();
    expect((await new Browser().json("/api/setup/resume", { body: { token: SETUP_TOKEN } })).status).toBe(201);
  });

  it("works with the SETUP_TOKEN secret; a short secret disables setup", async () => {
    const secret = "secret-setup-token-0123456789abcdefghijkl";
    const browser = new Browser();
    await env.DB.prepare("DELETE FROM installation").run();
    const status = await browser.json("/api/setup", { env: { SETUP_TOKEN: secret } });
    expect(status.body).toMatchObject({ tokenSource: "secret" });
    const owner = ownerDetails();
    const body = {
      token: secret,
      workspaceName: owner.workspace,
      ownerName: owner.name,
      ownerHandle: owner.handle,
      ownerEmail: owner.email,
    };
    expect(
      (await browser.json("/api/setup", { body: { ...body, token: SETUP_TOKEN }, env: { SETUP_TOKEN: secret } }))
        .status,
    ).toBe(403);
    const short = await new Browser().json("/api/setup", {
      body: { ...body, token: "short" },
      env: { SETUP_TOKEN: "short" },
    });
    expect(short.status).toBe(503);
    expect((await browser.json("/api/setup", { body, env: { SETUP_TOKEN: secret } })).status).toBe(201);
  });

  it("a set-but-invalid key secret blocks setup (setup_services_failing) and sign-in answers unavailable (/not-configured)", async () => {
    const owner = ownerDetails();
    const body = {
      token: SETUP_TOKEN,
      workspaceName: owner.workspace,
      ownerName: owner.name,
      ownerHandle: owner.handle,
      ownerEmail: owner.email,
    };
    for (const invalid of [
      { BETTER_AUTH_SECRET: "too-short" },
      { TOKEN_HASH_KEY: "too-short" },
      { BETTER_AUTH_SECRETS: "not a list" },
    ]) {
      const result = await new Browser().json("/api/setup", { body, env: invalid });
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ error: { code: "setup_services_failing" } });
      const signIn = await new Browser().json("/api/auth/passkey/generate-authenticate-options", { env: invalid });
      expect(signIn.status).toBe(503);
      expect(signIn.body).toMatchObject({ error: { code: "unavailable" } });
    }
    expect((await installation())?.setup_claim).toBeNull();
  });

  it("setup is limited to 5 attempts per minute per IP, before the token is checked", async () => {
    // The limiter's clock is the test's, so the minute can't roll over mid-burst (AGENTS §5).
    let now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const limiter = new FakeRateLimit(configuredLimit("AUTH_RATE_LIMITER"), () => now);
    const call = { env: { AUTH_RATE_LIMITER: limiter } };
    const wrongToken = "wrong-token-0123456789abcdefghijklmnopq";
    const browser = new Browser();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await claim(browser, ownerDetails(), wrongToken, call)).status);
    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses[5]).toBe(429);
    // Per IP: another client isn't held back.
    expect((await claim(new Browser(), ownerDetails(), wrongToken, call)).status).toBe(403);
    // Per minute: the same client may try again once the window has passed.
    now += 59_999;
    expect((await claim(browser, ownerDetails(), wrongToken, call)).status).toBe(429);
    now += 1;
    expect((await claim(browser, ownerDetails(), wrongToken, call)).status).toBe(403);
  });

  it("before setup completes, signed-in routes answer setup_required", async () => {
    const me = await new Browser().json("/api/me");
    expect(me.status).toBe(409);
    expect(me.body).toMatchObject({ error: { code: "setup_required" } });
  });

  it("generates and logs a token once when no secret is set", async () => {
    await env.DB.prepare("DELETE FROM installation").run();
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => lines.push(line);
    try {
      await Promise.all([new Browser().json("/api/setup"), new Browser().json("/api/setup")]);
    } finally {
      console.warn = original;
    }
    expect(lines.filter((l) => l.includes("officebox setup token"))).toHaveLength(1);
  });
});

describe("a claim that never got its owner (review m1)", () => {
  it("a thrown error while creating the owner releases the claim, so setup can be tried again", async () => {
    const owner = ownerDetails();
    const secrets = await identitySecrets(env, silent);
    if (!secrets.ok) throw new Error("secrets");
    const auth = authFor(env, secrets.value, { canonicalOrigin: ORIGIN, workspaceName: owner.workspace });
    const internal = (await auth.$context).internalAdapter;
    const spy = vi.spyOn(internal, "createUser").mockRejectedValueOnce(new Error("D1 is unreachable"));
    try {
      const failed = await claim(new Browser(), owner);
      expect(failed.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await installation())?.setup_claim).toBeNull();
    expect((await claim(new Browser(), owner)).status).toBe(201);
  });

  it("an orphaned claim: resume releases it (409 setup_released) and a new claim succeeds", async () => {
    await claim(new Browser(), ownerDetails());
    await env.DB.prepare("DELETE FROM users WHERE role = 'owner'").run();
    const resumed = await new Browser().json("/api/setup/resume", { body: { token: SETUP_TOKEN } });
    expect(resumed.status).toBe(409);
    expect(resumed.body).toMatchObject({ error: { code: "conflict", reason: "setup_released" } });
    expect((await installation())?.setup_claim).toBeNull();
    expect((await claim(new Browser(), ownerDetails())).status).toBe(201);
  });

  it("an orphaned claim doesn't block POST /setup either", async () => {
    await claim(new Browser(), ownerDetails());
    await env.DB.prepare("DELETE FROM users WHERE role = 'owner'").run();
    expect((await claim(new Browser(), ownerDetails())).status).toBe(201);
  });
});

describe("GET /api/setup stays cheap (review m2)", () => {
  it("runs the expiry batch only for a stale claim", async () => {
    await claim(new Browser(), ownerDetails());
    expect(await expireIfStale(ctx())).toBe(false);
    expect((await installation())?.setup_claim).not.toBeNull();
    await env.DB.prepare("UPDATE installation SET setup_claimed_at = ?")
      .bind(Date.now() - SETUP_CLAIM_TTL_MS - 1000)
      .run();
    expect(await expireIfStale(ctx())).toBe(true);
  });

  it("is rate-limited per IP (20 per minute)", async () => {
    const browser = new Browser();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await browser.call("/api/setup")).status);
    expect(statuses.slice(0, 20).every((st) => st === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe("claim expiry and repair (Identity §4.1, §9 'Setup expiry and repair')", () => {
  const age = (ms: number) =>
    env.DB.prepare("UPDATE installation SET setup_claimed_at = ?")
      .bind(Date.now() - ms)
      .run();

  it("an expired claim with no passkey and no session is deleted and cleared in one batch", async () => {
    const owner = ownerDetails();
    await claim(new Browser(), owner);
    await age(SETUP_CLAIM_TTL_MS + 1000);
    expect(await expireStaleClaim(ctx())).toBe(true);
    expect(await ownerOf(owner.email)).toBeNull();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM handles WHERE handle = ?")
        .bind(owner.handle)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    const row = await installation();
    expect(row).toMatchObject({
      setup_claim: null,
      setup_claimed_at: null,
      canonical_origin: null,
      allowed_hosts: null,
    });
    // Setup reopens: with a generated token, a new one is generated on the next visit.
    expect((await new Browser().json("/api/setup")).body).toMatchObject({ claimed: false });
  });

  it("a claim younger than 24 hours is left alone", async () => {
    const owner = ownerDetails();
    await claim(new Browser(), owner);
    await age(SETUP_CLAIM_TTL_MS - 60_000);
    expect(await expireStaleClaim(ctx())).toBe(false);
    expect(await ownerOf(owner.email)).not.toBeNull();
  });

  it("never deletes an owner who has a passkey, or has signed in; the claim stays whole", async () => {
    const owner = ownerDetails();
    const browser = new Browser();
    await claim(browser, owner);
    await registerPasskey(browser, new SoftAuthenticator());
    await env.DB.prepare("UPDATE installation SET setup_completed_at = NULL").run();
    await age(SETUP_CLAIM_TTL_MS + 1000);
    expect(await expireStaleClaim(ctx())).toBe(false);
    expect(await ownerOf(owner.email)).not.toBeNull();
    expect((await installation())?.canonical_origin).toBe(ORIGIN);

    await resetInstallation();
    await seedSetupToken();
    const second = ownerDetails();
    await claim(new Browser(), second);
    await env.DB.prepare("UPDATE users SET first_signed_in_at = ? WHERE email = ?")
      .bind(Date.now(), second.email)
      .run();
    await age(SETUP_CLAIM_TTL_MS + 1000);
    expect(await expireStaleClaim(ctx())).toBe(false);
    expect(await ownerOf(second.email)).not.toBeNull();
  });

  it("an orphaned claim (no owner row) is released too", async () => {
    await claim(new Browser(), ownerDetails());
    await env.DB.prepare("DELETE FROM users WHERE role = 'owner'").run();
    await age(SETUP_CLAIM_TTL_MS + 1000);
    expect(await expireStaleClaim(ctx())).toBe(true);
  });

  it("completion with a stale nonce is refused", async () => {
    const owner = ownerDetails();
    await claim(new Browser(), owner);
    const user = await ownerOf(owner.email);
    expect(await completeSetupClaim(ctx(), "01JSTALENONCE0000000000000", user!.id)).toBe(false);
    expect((await installation())?.setup_completed_at).toBeNull();
  });

  it("the hourly repair job completes setup when the owner has a passkey but completion didn't run", async () => {
    const owner = ownerDetails();
    const browser = new Browser();
    await claim(browser, owner);
    await registerPasskey(browser, new SoftAuthenticator());
    await env.DB.prepare("UPDATE installation SET setup_completed_at = NULL").run();
    const { clearSetupCache } = await import("../../src/features/identity/setup-state");
    clearSetupCache(env.DB);
    const job = IDENTITY_JOBS.find((j) => j.name === "identity.repair")!;
    await job.run({ ...ctx(), scheduledTime: Date.now() });
    expect((await installation())?.setup_completed_at).not.toBeNull();
  });

  it("the owner signs in with their passkey after setup", async () => {
    const browser = new Browser();
    const authenticator = new SoftAuthenticator();
    await claim(browser, ownerDetails());
    await registerPasskey(browser, authenticator);
    const fresh = new Browser();
    expect((await signInWithPasskey(fresh, authenticator)).verify.status).toBe(200);
  });
});
