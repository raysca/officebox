import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Worker integration tests run inside the Workers runtime (Miniflare) with the real wrangler.jsonc
// bindings. Proven configuration from spikes/realtime.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "../../wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
  },
});
