import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { addAuthenticator, E2E_VARS, expectNoAxeViolations } from "./fixtures";

/**
 * Quick start (PLAN M1b-1; Identity §4.1, §9; TDD §6.8). Each test runs its own fresh deploy: a
 * `wrangler dev` on its own port and empty local state, with **no Worker secrets at all** (no
 * `SETUP_TOKEN`, `BETTER_AUTH_SECRET` or `TOKEN_HASH_KEY`), so the open claim window applies and the
 * Worker generates its own sign-in keys. The window's end is reached by moving the recorded start back
 * an hour in local D1 (the injected clock of the end-to-end run), never by waiting.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const BASE_PORT = Number(process.env.E2E_PORT ?? 8788);
const WINDOW_MS = 60 * 60 * 1000;
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

interface Server {
  url: string;
  state: string;
  config: string;
  stop(): Promise<void>;
}

/** A copy of wrangler.jsonc without the R2 binding (R2 "not enabled"), with absolute paths. */
function configWithoutR2(): string {
  const source = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  const withoutR2 = source.replace(/\n {2}"r2_buckets": \[[\s\S]*?\n {2}\],\n/, "\n");
  if (withoutR2 === source) throw new Error("couldn't remove r2_buckets from wrangler.jsonc");
  const absolute = withoutR2
    .replace('"main": "apps/worker/src/index.ts"', `"main": ${JSON.stringify(join(ROOT, "apps/worker/src/index.ts"))}`)
    .replace('"directory": "apps/web/dist"', `"directory": ${JSON.stringify(join(ROOT, "apps/web/dist"))}`)
    .replace(
      '"migrations_dir": "apps/worker/migrations"',
      `"migrations_dir": ${JSON.stringify(join(ROOT, "apps/worker/migrations"))}`,
    );
  const path = join(ROOT, ".wrangler", "e2e", `no-r2-${process.pid}.jsonc`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, absolute);
  return path;
}

/** Resolves once nothing answers on the port (or after 15 s). */
async function waitForPortFree(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitForHealth(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output()}`);
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

/** Starts `wrangler dev` with only the test email sink as a variable: no secrets. */
async function startServer(slot: number, options: { state?: string; config?: string } = {}): Promise<Server> {
  const port = BASE_PORT + slot;
  await waitForPortFree(port);
  const state = options.state ?? mkdtempSync(join(tmpdir(), "officebox-e2e-quick-"));
  const config = options.config ?? join(ROOT, "wrangler.jsonc");
  if (!options.state) {
    execFileSync(
      "npx",
      ["wrangler", "--config", config, "d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
      {
        cwd: ROOT,
        stdio: "pipe",
        env,
      },
    );
  }
  const vars = Object.entries(E2E_VARS).flatMap(([name, value]) => ["--var", `${name}:${value}`]);
  const child = spawn(
    "npx",
    [
      "wrangler",
      "--config",
      config,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(port + 1000),
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
  const url = `http://localhost:${port}`;
  await waitForHealth(`http://127.0.0.1:${port}`, child, () => log);
  return {
    url,
    state,
    config,
    async stop() {
      // The whole process group (npx, wrangler, workerd): SIGTERM, then SIGKILL after 10 s, then wait
      // until the port is free, so a retry or the next test can reuse it.
      const pid = child.pid;
      if (pid !== undefined) {
        const exited = child.exitCode !== null ? Promise.resolve() : new Promise((r) => child.once("exit", r));
        const signal = (name: NodeJS.Signals) => {
          try {
            process.kill(-pid, name);
          } catch {
            // already gone
          }
        };
        signal("SIGTERM");
        const timedOut = await Promise.race([
          exited.then(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(true), 10_000)),
        ]);
        // Children of the group can outlive npx: always finish with SIGKILL.
        signal("SIGKILL");
        if (timedOut) await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      }
      await waitForPortFree(port);
    },
  };
}

/** Runs SQL against a server's local D1 and returns the first result set. */
function d1(server: Server, sql: string): Record<string, unknown>[] {
  const output = execFileSync(
    "npx",
    [
      "wrangler",
      "--config",
      server.config,
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      server.state,
      "--json",
      "--command",
      sql,
    ],
    { cwd: ROOT, stdio: "pipe", env },
  ).toString();
  const parsed = JSON.parse(output) as { results: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

async function fillWorkspace(page: Page, email: string) {
  await page.getByLabel("Workspace name").fill("Quick Start Co");
  await page.getByLabel("Your name").fill("Robin Park");
  await page.getByLabel("Email").fill(email);
}

async function finishWithPasskey(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: "Add your passkey" })).toBeVisible();
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add a second passkey" })).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("Quick Start Co");
}

// Serial: each test owns a fixed port pair, and a retry must not overlap a server still shutting down.
test.describe.configure({ mode: "serial", timeout: 240_000 });

test("a fresh deploy with no secrets: set up inside the open window with no token, and signed in", async ({
  page,
  context,
}) => {
  const server = await startServer(3);
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await addAuthenticator(context, page);
    await page.goto(`${server.url}/chat`);
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("heading", { level: 1, name: "Set up your workspace" })).toBeVisible();
    await expect(page.getByText(/No setup token is needed until .* \((60|59) minutes left\)/)).toBeVisible();
    await expect(page.getByText(/anyone who opens this address can claim this workspace/)).toBeVisible();
    await expect(page.getByLabel("Setup token (optional)")).toBeVisible();
    await expectNoAxeViolations(page);

    await fillWorkspace(page, "robin@example.com");
    await page.getByRole("button", { name: "Create workspace" }).click();
    // The resume code is shown once, with the passkey step.
    await expect(page.getByRole("textbox", { name: "Setup resume code" })).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
    await expectNoAxeViolations(page);
    await finishWithPasskey(page);

    // The keys came from the Worker: Admin → Settings says so, never with a value.
    await page.goto(`${server.url}/admin/settings`);
    const keys = page.getByRole("region", { name: "Sign-in keys" });
    await expect(keys.getByText("Generated by the Worker")).toHaveCount(2);
    await expectNoAxeViolations(page);
    // The claim was audited in open mode.
    const audit = d1(server, "SELECT metadata FROM audit_log WHERE action = 'setup.claim'");
    expect(JSON.parse(String(audit[0]?.metadata))).toEqual({ mode: "open" });
  } finally {
    await server.stop();
  }
});

test("after the open window, setup asks for the token and keeps what was typed", async ({ page, context }) => {
  const server = await startServer(4);
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await addAuthenticator(context, page);
    await page.goto(`${server.url}/setup`);
    await expect(page.getByText(/No setup token is needed until/)).toBeVisible();
    await fillWorkspace(page, "robin@example.com");

    // The window ends while the form is open: move its recorded start back an hour, and put a known
    // generated token in place of the one written to the logs.
    const token = "e2e-generated-token-0123456789abcdefghijklmn";
    const hash = createHash("sha256").update(token).digest("base64url");
    d1(
      server,
      `UPDATE installation SET setup_opened_at = setup_opened_at - ${WINDOW_MS},
         setup_token_hash = '${hash}', setup_token_expires_at = ${Date.now() + 23 * WINDOW_MS} WHERE id = 1`,
    );
    await page.getByRole("button", { name: "Create workspace" }).click();
    const field = page.getByLabel("Setup token", { exact: true });
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toBeFocused();
    await expect(
      page.getByText("The open setup period has ended. Enter the setup token to continue; what you typed is kept."),
    ).toBeVisible();
    await expect(page.getByLabel("Workspace name")).toHaveValue("Quick Start Co");
    await expect(page.getByText(/No setup token is needed/)).toHaveCount(0);
    await expectNoAxeViolations(page);

    await field.fill(token);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByRole("textbox", { name: "Setup resume code" })).toHaveCount(0);
    await finishWithPasskey(page);
    const audit = d1(server, "SELECT metadata FROM audit_log WHERE action = 'setup.claim'");
    expect(JSON.parse(String(audit[0]?.metadata))).toEqual({ mode: "token", setupVia: "generated" });
  } finally {
    await server.stop();
  }
});

test("the required-services checklist blocks setup and the window while R2 is unbound, then proceeds", async ({
  page,
  context,
}) => {
  const noR2 = configWithoutR2();
  let server = await startServer(5, { config: noR2 });
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await addAuthenticator(context, page);
    await page.goto(`${server.url}/setup`);
    await expect(page.getByRole("heading", { level: 1, name: "Officebox isn't ready to set up yet" })).toBeVisible();
    const list = page.getByRole("list", { name: "Required services" });
    await expect(
      list.getByText("R2 isn't enabled on this Cloudflare account: dashboard → R2, then redeploy."),
    ).toBeVisible();
    await expect(list.getByText("Working")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Create workspace" })).toHaveCount(0);
    await expectNoAxeViolations(page);
    // Nothing else is offered, and the open window hasn't started.
    const claim = await page.request.post(`${server.url}/api/setup`, {
      headers: { "X-Officebox-Request": "1", Origin: server.url },
      data: {
        workspaceName: "Quick Start Co",
        ownerName: "Robin Park",
        ownerHandle: "robin",
        ownerEmail: "r@example.com",
      },
    });
    expect(claim.status()).toBe(503);
    expect((await claim.json()) as unknown).toMatchObject({ error: { code: "setup_services_failing" } });
    expect(d1(server, "SELECT setup_opened_at FROM installation WHERE id = 1")[0]?.setup_opened_at ?? null).toBeNull();

    // R2 enabled and redeployed: the same state with the normal configuration.
    const state = server.state;
    await server.stop();
    server = await startServer(5, { state });
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByText(/No setup token is needed until .* \((60|59) minutes left\)/)).toBeVisible();
    expect(
      Number(d1(server, "SELECT setup_opened_at FROM installation WHERE id = 1")[0]?.setup_opened_at),
    ).toBeGreaterThan(0);
    await expectNoAxeViolations(page);
    await fillWorkspace(page, "robin@example.com");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await finishWithPasskey(page);
  } finally {
    await server.stop();
  }
});
