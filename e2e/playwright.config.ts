import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_SECRETS, E2E_VARS, OWNER_STATE } from "./tests/fixtures";

// End-to-end tests run against `wrangler dev` serving the built web app through Workers Assets, the
// same path as production. Build first (`npm run build`); the root `npm run e2e` does both.
const PORT = Number(process.env.E2E_PORT ?? 8788);
// The browser uses `localhost`: WebAuthn needs a domain as the relying-party ID (an IP address isn't
// one), and Chromium treats http://localhost as a secure context, so passkeys and the Secure `__Host-`
// cookies work. The setup claim records this origin as the canonical origin.
const BASE_URL = `http://localhost:${PORT}`;
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

// Test-only Worker secrets (Platform §16) and the test email sink, passed as --var so no .dev.vars file
// is needed.
const vars = Object.entries({ ...E2E_SECRETS, ...E2E_VARS })
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
  // Three stages against one installation: first-run setup with the owner's passkey (saving the
  // session and the virtual authenticator's credential), then the shell tests as that owner, then the
  // passkey and session flows, which end by signing every session out.
  projects: [
    { name: "setup", testMatch: /first-run\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium",
      dependencies: ["setup"],
      testIgnore: [/first-run\.setup\.ts/, /passkeys\.spec\.ts/, /onboarding\.spec\.ts/, /quick-start\.spec\.ts/],
      use: { ...devices["Desktop Chrome"], storageState: OWNER_STATE },
    },
    {
      name: "passkeys",
      dependencies: ["chromium"],
      testMatch: /passkeys\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // M1b: invitations, email and magic links. After the passkeys project, so the owner has the second
    // passkey the invite gate asks for.
    {
      name: "onboarding",
      dependencies: ["passkeys"],
      testMatch: /onboarding\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // M1b-1 quick start: each test starts its own fresh deploy (wrangler dev on E2E_PORT + 3…5, with no
    // Worker secrets), so it needs nothing from the shared installation above.
    {
      name: "quick-start",
      testMatch: /quick-start\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      `${wrangler} d1 migrations apply DB --local --persist-to "${STATE}" && ` +
      `${wrangler} dev --ip 127.0.0.1 --port ${PORT} --show-interactive-dev-session=false --persist-to "${STATE}" ${vars}`,
    // Node resolves "localhost" to ::1 first on some systems; the server listens on 127.0.0.1.
    url: `http://127.0.0.1:${PORT}/health`,
    // Always start a fresh server from the current build, never a stale one left running. If the port
    // is taken, Playwright fails with a clear error; pick another with E2E_PORT.
    reuseExistingServer: false,
    timeout: 120_000,
    env: { WRANGLER_SEND_METRICS: "false", NO_PROXY: noProxy, no_proxy: noProxy },
  },
});
