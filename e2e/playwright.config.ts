import { defineConfig, devices } from "@playwright/test";

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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx wrangler dev --config ../wrangler.jsonc --ip 127.0.0.1 --port ${PORT} --show-interactive-dev-session=false`,
    url: `${BASE_URL}/health`,
    // Always start a fresh server from the current build, never a stale one left running. If the port
    // is taken, Playwright fails with a clear error; pick another with E2E_PORT.
    reuseExistingServer: false,
    timeout: 120_000,
    env: { WRANGLER_SEND_METRICS: "false", NO_PROXY: noProxy, no_proxy: noProxy },
  },
});
