import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/log";
import { IDENTITY_JOBS } from "../../src/features/identity/jobs";
import { observeRelease } from "../../src/features/identity/setup";
import { SoftAuthenticator } from "./authenticator";
import { Browser, ownerDetails, registerPasskey, resetInstallation, useTestClock, type TestClock } from "./helpers";

/**
 * The operator's setup release (M1b-1; Identity §4.1, §9; TDD §6.8): `scripts/setup-release.sql`, run
 * here exactly as `wrangler d1 execute --file` would (its statements as one batch), and the Worker's
 * `setup.released_outside_app` audit entry, written once by whichever observer comes first.
 */

const silent = createLogger({}, () => {});
let clock: TestClock;

/** The release file's statements, comments removed, run as one batch. */
async function runReleaseScript(): Promise<boolean[]> {
  const sql = env.SETUP_RELEASE_SQL.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  expect(statements).toHaveLength(3);
  const results = await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  // Whether each statement changed anything (a user delete also counts the rows it cascades to).
  return results.map((r) => r.meta.changes > 0);
}

const row = () =>
  env.DB.prepare("SELECT setup_claim, setup_opened_at, canonical_origin FROM installation WHERE id = 1").first<{
    setup_claim: string | null;
    setup_opened_at: number | null;
    canonical_origin: string | null;
  }>();
const releaseEntries = async () =>
  (
    await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'setup.released_outside_app'").first<{
      n: number;
    }>()
  )?.n ?? 0;
const owners = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM users WHERE role = 'owner'").first<{ n: number }>())?.n ?? 0;

async function openClaim() {
  const browser = new Browser();
  const owner = ownerDetails();
  await browser.json("/api/setup");
  const claimed = await browser.json("/api/setup", {
    body: { workspaceName: owner.workspace, ownerName: owner.name, ownerHandle: owner.handle, ownerEmail: owner.email },
  });
  expect(claimed.status).toBe(201);
  return { browser, owner };
}

const repair = () =>
  IDENTITY_JOBS.find((j) => j.name === "identity.repair")!.run({
    env,
    log: silent,
    now: () => clock.now,
    scheduledTime: clock.now,
  });

beforeEach(async () => {
  await resetInstallation();
  await env.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'setup.%'").run();
  clock = useTestClock(Date.now());
});
afterEach(() => {
  useTestClock(null);
});

describe("scripts/setup-release.sql", () => {
  it("releases an unfinished claim at once and ends the open window; the next setup request audits it once", async () => {
    const { owner } = await openClaim();
    expect(await runReleaseScript()).toEqual([true, true, true]);
    expect(await row()).toMatchObject({ setup_claim: null, canonical_origin: null, setup_opened_at: 0 });
    expect(await owners()).toBe(0);
    const handle = await env.DB.prepare("SELECT count(*) AS n FROM handles WHERE handle = ?")
      .bind(owner.handle)
      .first<{ n: number }>();
    expect(handle?.n).toBe(0);
    // The resume code went with the owner.
    const codes = await env.DB.prepare("SELECT count(*) AS n FROM auth_tokens WHERE kind = 'setup_resume'").first<{
      n: number;
    }>();
    expect(codes?.n).toBe(0);
    expect(await releaseEntries()).toBe(0);

    const status = await new Browser().json("/api/setup");
    expect(status.body).toMatchObject({ claimed: false, mode: "token" });
    expect(await releaseEntries()).toBe(1);
    expect((await row())?.setup_opened_at).toBe(-1);
    const entry = await env.DB.prepare(
      "SELECT actor_id, metadata FROM audit_log WHERE action = 'setup.released_outside_app'",
    ).first<{ actor_id: string | null; metadata: string }>();
    expect(entry?.actor_id).toBeNull();
    expect(JSON.parse(entry!.metadata)).toEqual({ observedAt: clock.now });

    // Later requests and the repair job write nothing more; the window stays closed.
    await new Browser().json("/api/setup");
    await repair();
    expect(await releaseEntries()).toBe(1);
    const late = await new Browser().json("/api/setup", {
      body: { workspaceName: "Acme", ownerName: "Pat", ownerHandle: "pat", ownerEmail: "pat@officebox.test" },
    });
    expect(late.body).toMatchObject({ error: { code: "setup_token_required" } });
  });

  it("the repair job observes a release too, and concurrent observers write exactly one entry", async () => {
    await openClaim();
    await runReleaseScript();
    await Promise.all([
      repair(),
      new Browser().json("/api/setup"),
      new Browser().json("/api/setup"),
      observeRelease({ env, log: silent, now: () => clock.now }),
    ]);
    expect(await releaseEntries()).toBe(1);
  });

  it("the repair job alone writes the entry when no setup request comes", async () => {
    await openClaim();
    await runReleaseScript();
    await repair();
    expect(await releaseEntries()).toBe(1);
    expect((await row())?.setup_opened_at).toBe(-1);
  });

  it("changes nothing against an owner with a passkey or a session; running it twice changes nothing more", async () => {
    const { browser } = await openClaim();
    const reg = await registerPasskey(browser, new SoftAuthenticator());
    expect(reg.verify?.status).toBe(200);
    const before = await row();
    expect(await runReleaseScript()).toEqual([false, false, false]);
    expect(await row()).toEqual(before);
    expect(await owners()).toBe(1);

    // An owner who signed in (no passkey) is kept too.
    await resetInstallation();
    await openClaim();
    await env.DB.prepare("UPDATE users SET first_signed_in_at = ? WHERE role = 'owner'").bind(clock.now).run();
    expect(await runReleaseScript()).toEqual([false, false, false]);
    expect(await owners()).toBe(1);
    expect((await row())?.setup_opened_at).toBeGreaterThan(0);
  });

  it("after setup completes, the hourly job never writes: no marker, no entry, setup_opened_at unchanged", async () => {
    const { browser } = await openClaim();
    expect((await registerPasskey(browser, new SoftAuthenticator())).verify?.status).toBe(200);
    const before = await row();
    const writes = await env.DB.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>();
    await repair();
    await repair();
    expect(await row()).toEqual(before);
    expect(await releaseEntries()).toBe(0);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>();
    expect(after?.n).toBe(writes?.n);
    // Completion revoked the setup resume code; the daily prune deletes it a day after it expires.
    const code = await env.DB.prepare(
      "SELECT revoked_at, expires_at FROM auth_tokens WHERE kind = 'setup_resume'",
    ).first<{
      revoked_at: number | null;
      expires_at: number;
    }>();
    expect(code?.revoked_at).not.toBeNull();
    const prune = IDENTITY_JOBS.find((j) => j.name === "identity.prune")!;
    const later = code!.expires_at + 24 * 60 * 60 * 1000 + 1;
    await prune.run({ env, log: silent, now: () => later, scheduledTime: later });
    const left = await env.DB.prepare("SELECT count(*) AS n FROM auth_tokens WHERE kind = 'setup_resume'").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });

  it("a release that matched nothing produces no audit entry, and a second run changes nothing", async () => {
    await new Browser().json("/api/setup"); // the window open, nothing claimed
    expect(await runReleaseScript()).toEqual([false, false, false]);
    const opened = (await row())?.setup_opened_at;
    expect(opened).toBeGreaterThan(0);
    await new Browser().json("/api/setup");
    await repair();
    expect(await releaseEntries()).toBe(0);

    await openClaim();
    expect(await runReleaseScript()).toEqual([true, true, true]);
    expect(await runReleaseScript()).toEqual([false, false, false]);
    await new Browser().json("/api/setup");
    expect(await releaseEntries()).toBe(1);
  });
});
