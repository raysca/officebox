import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against `wrangler dev` serving the built web app through Workers Assets, the
// same path as production. Build first (`npm run build`); the root `npm run e2e` does both.
const PORT = Number(process.env.E2E_PORT ?? 8788);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CI = Boolean(process.env.CI);

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
    reuseExistingServer: !CI,
    timeout: 120_000,
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
