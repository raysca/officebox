import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
          // The operator's setup release, run by test/identity/setup-release.test.ts as wrangler would.
          SETUP_RELEASE_SQL: readFileSync(
            fileURLToPath(new URL("../../scripts/setup-release.sql", import.meta.url)),
            "utf8",
          ),
          // Test-only identity secrets (Platform §16); never used anywhere else.
          BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdefghijkl",
          TOKEN_HASH_KEY: "test-token-hash-key-0123456789abcdefghijklmnop",
        },
        durableObjects: {
          SYSTEM: { className: "SystemObject", useSQLite: true },
          USER_HUB: { className: "UserHub", useSQLite: true },
          PRESENCE: { className: "WorkspacePresence", useSQLite: true },
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
