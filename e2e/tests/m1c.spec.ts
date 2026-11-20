import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addAuthenticator, E2E_VARS, expectNoAxeViolations, linkIn, type SinkEmail } from "./fixtures";

/**
 * M1c end to end (PLAN M1 exit criteria "recovery link", "owner recovery with RECOVERY_TOKEN", "email
 * change"; Identity §4.4, §4.6, §4.11, §9): one fresh deploy of its own (the domain move at the end
 * signs everyone out and changes the canonical origin, so it can't share the main installation), set
 * up in the open claim window, with `RECOVERY_TOKEN` set and email through the test sink.
 *
 * The domain move uses two local names for the same server: `localhost` (the setup origin) and
 * `moved.localhost`. Chromium resolves `*.localhost` to the loopback address and treats it as a secure
 * context, so passkeys work on both, each with its own relying-party ID.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const SLOT = 6;
const PORT = Number(process.env.E2E_PORT ?? 8788) + SLOT;
const OLD = `http://localhost:${PORT}`;
const MOVED = `http://moved.localhost:${PORT}`;
const RECOVERY_TOKEN = "e2e-recovery-token-0123456789abcdefghijklmnop";
const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, "127.0.0.1", "localhost", ".localhost"]
  .filter(Boolean)
  .join(",");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: noProxy, no_proxy: noProxy };

const OWNER = { workspace: "Recovery Co", name: "Robin Park", email: "robin@example.com" };
const MEMBER = { name: "Ana Diaz", email: "ana@example.com", newEmail: "ana.diaz@example.com" };

let state = "";
let child: ChildProcess | null = null;

async function waitForHealth(url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`wrangler dev exited:\n${output()}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.status === 200 || res.status === 503) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev didn't start:\n${output()}`);
}

/**
 * A test-only copy of wrangler.jsonc for this deploy: absolute paths, and every Rate Limiting binding
 * raised to 1000 a minute, because all of this run's browsers share one IP and the flows here would
 * otherwise have to wait out the per-IP windows (Platform §8). It lives under the git-ignored
 * `.wrangler/` and is only ever passed to this local `wrangler dev`, so it can't reach a deployment.
 * The limits themselves are covered by the Worker integration tests.
 */
function testConfig(): string {
  const source = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  const pattern = /"simple": \{ "limit": \d+, "period": (10|60) \}/g;
  const bindings = source.match(/"name": "[A-Z_]+_RATE_LIMITER"/g) ?? [];
  const matched = source.match(pattern) ?? [];
  // Every Rate Limiting binding must be raised, or a step would hit its real limit.
  if (bindings.length !== 5 || matched.length !== bindings.length) {
    throw new Error(
      `expected 5 rate-limit bindings to raise; found ${bindings.length} bindings, ${matched.length} limits`,
    );
  }
  const raised = source.replace(pattern, '"simple": { "limit": 1000, "period": $1 }');
  const absolute = raised
    .replace('"main": "apps/worker/src/index.ts"', `"main": ${JSON.stringify(join(ROOT, "apps/worker/src/index.ts"))}`)
    .replace('"directory": "apps/web/dist"', `"directory": ${JSON.stringify(join(ROOT, "apps/web/dist"))}`)
    .replace(
      '"migrations_dir": "apps/worker/migrations"',
      `"migrations_dir": ${JSON.stringify(join(ROOT, "apps/worker/migrations"))}`,
    );
  const dir = join(ROOT, ".wrangler", "e2e");
  mkdirSync(dir, { recursive: true });
  // Copies left by earlier runs (one per process) are removed.
  for (const name of readdirSync(dir)) if (/^m1c-\d+\.jsonc$/.test(name)) rmSync(join(dir, name), { force: true });
  const path = join(dir, `m1c-${process.pid}.jsonc`);
  writeFileSync(path, absolute);
  return path;
}

let config = "";

async function startServer(): Promise<void> {
  state = mkdtempSync(join(tmpdir(), "officebox-e2e-m1c-"));
  config = testConfig();
  execFileSync(
    "npx",
    ["wrangler", "--config", config, "d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
    {
      cwd: ROOT,
      stdio: "pipe",
      env,
    },
  );
  const vars = Object.entries({ ...E2E_VARS, RECOVERY_TOKEN }).flatMap(([name, value]) => [
    "--var",
    `${name}:${value}`,
  ]);
  child = spawn(
    "npx",
    [
      "wrangler",
      "--config",
      config,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--inspector-port",
      String(PORT + 1000),
      "--show-interactive-dev-session=false",
      "--persist-to",
      state,
      ...vars,
    ],
    { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  await waitForHealth(`http://127.0.0.1:${PORT}`, () => log);
}

async function stopServer(): Promise<void> {
  const pid = child?.pid;
  if (!child || pid === undefined) return;
  const exited = child.exitCode !== null ? Promise.resolve() : new Promise((r) => child?.once("exit", r));
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // already gone
    }
  };
  if (config) rmSync(config, { force: true });
  signal("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 10_000)),
  ]);
  if (timedOut) signal("SIGKILL");
}

function d1(sql: string): Record<string, unknown>[] {
  const output = execFileSync(
    "npx",
    [
      "wrangler",
      "--config",
      config,
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      state,
      "--json",
      "--command",
      sql,
    ],
    { cwd: ROOT, stdio: "pipe", env },
  ).toString();
  const parsed = JSON.parse(output) as { results: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

function sink(to: string): SinkEmail[] {
  try {
    return d1(
      `SELECT recipient, subject, text FROM email_test_sink WHERE lower(recipient) = lower('${to.replace(/'/g, "''")}') ORDER BY created_at`,
    ) as unknown as SinkEmail[];
  } catch {
    return [];
  }
}

async function newPerson(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await addAuthenticator(context, page);
  return { context, page };
}

/** One passkey step. This deploy's limits are raised (`testConfig`), so no step waits out a window. */
async function step(_page: Page, act: () => Promise<unknown>, done: ReturnType<Page["getByRole"]>) {
  await act();
  await expect(done).toBeVisible({ timeout: 15_000 });
}

test.describe.configure({ mode: "serial", timeout: 300_000 });

let owner: { context: BrowserContext; page: Page };
let member: { context: BrowserContext; page: Page };

test.beforeAll(async () => {
  await startServer();
});
test.afterAll(async () => {
  await stopServer();
});

test("set up, turn email on, and invite a member (the starting point)", async ({ browser }) => {
  owner = await newPerson(browser);
  const page = owner.page;
  await page.goto(`${OLD}/setup`);
  await page.getByLabel("Workspace name").fill(OWNER.workspace);
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await step(
    page,
    () => page.getByRole("button", { name: "Create passkey" }).click(),
    page.getByRole("heading", { level: 1, name: "Add a second passkey" }),
  );
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

  await page.goto(`${OLD}/admin/settings`);
  await page.getByLabel("Email service").selectOption("cloudflare");
  await page.getByLabel("Sender address").fill("no-reply@example.com");
  await page.getByRole("button", { name: "Save email settings" }).click();
  await expect(page.getByText("Email is on (Cloudflare Email Service).")).toBeVisible();

  // RECOVERY_TOKEN is set and unused, so the owner meets the invite gate with one passkey.
  await page.goto(`${OLD}/admin/invitations`);
  await page.getByRole("button", { name: "Invite someone" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await dialog.getByLabel("Email", { exact: true }).fill(MEMBER.email);
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  const linkDialog = page.getByRole("dialog", { name: "Invitation link" });
  const link = await linkDialog.getByLabel("Link to share").inputValue();
  await linkDialog.getByRole("button", { name: "Done" }).click();

  member = await newPerson(browser);
  await member.page.goto(link);
  await member.page.getByLabel("Your name").fill(MEMBER.name);
  await member.page.getByRole("button", { name: "Accept and continue" }).click();
  await step(
    member.page,
    () => member.page.getByRole("button", { name: "Create passkey" }).click(),
    member.page.getByRole("heading", { level: 1, name: "Home" }),
  );
});

test("a recovery link: step-up to issue, the email shown, a new passkey, every old session signed out", async ({
  browser,
}) => {
  const page = owner.page;
  // Age the owner's last passkey assertion, so issuing needs step-up.
  d1("UPDATE sessions SET fresh_auth_at = 0");
  await page.goto(`${OLD}/admin`);
  await page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: `Issue a recovery link for ${MEMBER.name}` }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Use passkey" }).click();
  const dialog = page.getByRole("dialog", { name: "Recovery link" });
  await expect(dialog).toBeVisible();
  const link = await dialog.getByLabel("Recovery link").inputValue();
  expect(link).toMatch(new RegExp(`^${OLD}/auth/recover#t=[A-Za-z0-9_-]{43}$`));
  await expectNoAxeViolations(page);
  await dialog.getByRole("button", { name: "Done" }).click();
  // The member was told by email.
  await expect.poll(() => sink(MEMBER.email).some((m) => m.subject.includes("A recovery link was issued"))).toBe(true);

  const recovering = await newPerson(browser);
  await recovering.page.goto(link);
  await expect(recovering.page.getByRole("heading", { level: 1, name: "Recover your account" })).toBeVisible();
  await expect(recovering.page.getByText(MEMBER.email, { exact: true })).toBeVisible();
  expect(recovering.page.url()).not.toContain("#");
  await expectNoAxeViolations(recovering.page);
  await recovering.page.getByRole("button", { name: "Continue" }).click();
  await expect(recovering.page.getByRole("heading", { level: 1, name: "Create your new passkey" })).toBeVisible();
  await expectNoAxeViolations(recovering.page);
  await step(
    recovering.page,
    () => recovering.page.getByRole("button", { name: "Create passkey" }).click(),
    recovering.page.getByRole("heading", { level: 1, name: "Home" }),
  );
  await expect(recovering.page.getByRole("region", { name: "Security notices" })).toContainText(
    "issued a recovery link for your account",
  );

  // The member's old session was signed out.
  await member.page.goto(`${OLD}/chat`);
  await expect(member.page).toHaveURL(/\/sign-in/);
  // Used up: the link answers that it isn't valid any more.
  await recovering.page.goto(link);
  await expect(recovering.page.getByText(/This recovery link isn't valid any more/)).toBeVisible();
  await member.context.close();
  member = recovering;
});

test("an email change: step-up, a confirmation link to the new address, a notice to the old one", async ({
  browser,
}) => {
  const page = owner.page;
  await page.goto(`${OLD}/admin/members`);
  await page.getByRole("button", { name: `Change email for ${MEMBER.name}` }).click();
  const dialog = page.getByRole("dialog", { name: "Change email" });
  await dialog.getByLabel("New email").fill(MEMBER.newEmail);
  await expectNoAxeViolations(page);
  await dialog.getByRole("button", { name: "Change email" }).click();
  await expect(dialog.getByText(`A confirmation link was sent to ${MEMBER.newEmail}.`)).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(`Waiting for ${MEMBER.newEmail} to confirm`)).toBeVisible();

  await expect.poll(() => sink(MEMBER.newEmail).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const link = linkIn(sink(MEMBER.newEmail)[0]!);
  expect(link.startsWith(`${OLD}/me/email/confirm#t=`)).toBe(true);
  const reader = await browser.newContext();
  const readerPage = await reader.newPage();
  await readerPage.goto(link);
  await expect(readerPage.getByRole("heading", { level: 1, name: "Confirm your new email" })).toBeVisible();
  await expect(readerPage.getByText(MEMBER.newEmail, { exact: true })).toBeVisible();
  await expectNoAxeViolations(readerPage);
  await readerPage.getByRole("button", { name: "Confirm" }).click();
  await expect(readerPage.getByText(`Your email address is now ${MEMBER.newEmail}.`)).toBeVisible();
  await expectNoAxeViolations(readerPage);
  await reader.close();

  await expect
    .poll(() => sink(MEMBER.email).some((m) => m.subject.includes("Your email address was changed")), {
      timeout: 30_000,
    })
    .toBe(true);
  await page.reload();
  await expect(page.getByRole("cell", { name: MEMBER.newEmail })).toBeVisible();
});

test("owner recovery with RECOVERY_TOKEN: a new passkey for the owner, once; owners see the banner", async ({
  browser,
}) => {
  const recovering = await newPerson(browser);
  const page = recovering.page;
  await page.goto(`${OLD}/sign-in`);
  await page.getByRole("link", { name: "owner recovery" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Owner recovery" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByLabel("Owner's email").fill(OWNER.email);
  await page.getByLabel("Recovery token").fill("not-the-recovery-token-0123456789abcdef");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That recovery token isn't right.")).toBeVisible();
  await page.getByLabel("Recovery token").fill(RECOVERY_TOKEN);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Create your new passkey" })).toBeVisible();
  await step(
    page,
    () => page.getByRole("button", { name: "Create passkey" }).click(),
    page.getByRole("heading", { level: 1, name: "Home" }),
  );
  await expect(page.getByRole("region", { name: "Owner recovery" })).toContainText("Delete that Worker secret");
  await expectNoAxeViolations(page);

  // The owner's earlier session was signed out; the value never works twice.
  await owner.page.goto(`${OLD}/chat`);
  await expect(owner.page).toHaveURL(/\/sign-in/);
  await owner.context.close();
  owner = recovering;
  const again = await browser.newContext();
  const againPage = await again.newPage();
  await againPage.goto(`${OLD}/recover`);
  await againPage.getByLabel("Owner's email").fill(OWNER.email);
  await againPage.getByLabel("Recovery token").fill(RECOVERY_TOKEN);
  await againPage.getByRole("button", { name: "Continue" }).click();
  await expect(againPage.getByText(/already been used/)).toBeVisible();
  await again.close();
});

test("the domain move: step-up start, commit by a passkey on the new origin, the old host redirects", async ({
  browser,
}) => {
  const page = owner.page;
  d1("UPDATE sessions SET fresh_auth_at = 0");
  await page.goto(`${OLD}/admin`);
  await page.getByRole("link", { name: "Workspace address" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Workspace address" })).toBeVisible();
  await expect(page.getByText(OLD, { exact: true })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByLabel("New address", { exact: true }).fill(MOVED);
  await page.getByRole("button", { name: "Start the move" }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await prompt.getByRole("button", { name: "Use passkey" }).click();
  const dialog = page.getByRole("dialog", { name: "Move link" });
  const link = await dialog.getByLabel("Move link").inputValue();
  expect(link.startsWith(`${MOVED}/admin/domain/complete#t=`)).toBe(true);
  await expectNoAxeViolations(page);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("region", { name: "Move in progress" })).toContainText(MOVED);
  // The old origin keeps working until the commit.
  await page.goto(`${OLD}/calendar`);
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();

  const mover = await newPerson(browser);
  await mover.page.goto(link);
  await expect(mover.page.getByRole("heading", { level: 1, name: "Finish moving the workspace" })).toBeVisible();
  await expectNoAxeViolations(mover.page);
  await mover.page.getByRole("button", { name: "Continue" }).click();
  await expect(
    mover.page.getByRole("heading", { level: 1, name: "Create a passkey for the new address" }),
  ).toBeVisible();
  await step(
    mover.page,
    () => mover.page.getByRole("button", { name: "Create passkey and move" }).click(),
    mover.page.getByRole("heading", { level: 1, name: "Home" }),
  );
  expect(new URL(mover.page.url()).origin).toBe(MOVED);

  // The old host now redirects, keeping the path; the session on the new origin carries on.
  await mover.page.goto(`${OLD}/documents?view=list`);
  await expect(mover.page).toHaveURL(`${MOVED}/documents?view=list`);
  await expect(mover.page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  // Everyone else was signed out: the old session lands on the new origin's sign-in page.
  await page.goto(`${OLD}/chat`);
  await expect(page).toHaveURL(new RegExp(`^${MOVED.replace(/\./g, "\\.")}/sign-in`));
  await member.page.goto(`${MOVED}/`);
  await expect(member.page).toHaveURL(/\/sign-in/);
  // The API redirects too: 302 with no-store, never a cached 301.
  const redirect = await mover.page.request.get(`${OLD}/api/me`, { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers()["location"]).toBe(`${MOVED}/api/me`);
  expect(redirect.headers()["cache-control"]).toBe("no-store");
});
