import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Worker integration tests run inside the Workers runtime (Miniflare) with the real wrangler.jsonc
// bindings. Proven configuration from spikes/realtime.
//
// `main` is a test entry that re-exports the real Worker plus test-only Durable Object classes
// (test/fixtures), bound below. Production code and wrangler.jsonc never see them.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./test/worker.ts",
      wrangler: { configPath: "../../wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
        durableObjects: {
          SYSTEM: { className: "SystemObject", useSQLite: true },
          TEST_OBJECT: { className: "TestObject", useSQLite: true },
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/node/**"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
  },
});
