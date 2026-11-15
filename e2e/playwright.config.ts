import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_SECRETS, OWNER_STATE } from "./tests/fixtures";

// End-to-end tests run against `wrangler dev` serving the built web app through Workers Assets, the
// same path as production. Build first (`npm run build`); the root `npm run e2e` does both.
const PORT = Number(process.env.E2E_PORT ?? 8788);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CI = Boolean(process.env.CI);

// Behind an HTTP proxy, Playwright's readiness probe of the local server (and the browser's requests)
// must not go through the proxy. Add the loopback hosts to NO_PROXY for this process and the server.
const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
process.env.NO_PROXY = noProxy;
process.env.no_proxy = noProxy;

// Every run starts from a fresh deploy: an empty D1 database in a new directory, migrated before the
// server starts. Workers load this file too and inherit the variable, so only the runner creates one.
process.env.OFFICEBOX_E2E_STATE ??= mkdtempSync(join(tmpdir(), "officebox-e2e-"));
const STATE = process.env.OFFICEBOX_E2E_STATE;

// Test-only Worker secrets (Platform §16), passed as --var so no .dev.vars file is needed.
const vars = Object.entries(E2E_SECRETS)
  .map(([name, value]) => `--var ${name}:${value}`)
  .join(" ");
const wrangler = `npx wrangler --config ../wrangler.jsonc`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  // Three stages against one installation: first-run setup and the owner's sign-in (saving the
  // session), then the shell tests as that owner, then the flow that signs every session out.
  projects: [
    { name: "setup", testMatch: /first-run\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium",
      dependencies: ["setup"],
      testIgnore: [/first-run\.setup\.ts/, /sessions\.spec\.ts/],
      use: { ...devices["Desktop Chrome"], storageState: OWNER_STATE },
    },
    {
      name: "sessions",
      dependencies: ["chromium"],
      testMatch: /sessions\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      `${wrangler} d1 migrations apply DB --local --persist-to "${STATE}" && ` +
      `${wrangler} dev --ip 127.0.0.1 --port ${PORT} --show-interactive-dev-session=false --persist-to "${STATE}" ${vars}`,
    url: `${BASE_URL}/health`,
    // Always start a fresh server from the current build, never a stale one left running. If the port
    // is taken, Playwright fails with a clear error; pick another with E2E_PORT.
    reuseExistingServer: false,
    timeout: 120_000,
    env: { WRANGLER_SEND_METRICS: "false", NO_PROXY: noProxy, no_proxy: noProxy },
  },
});
