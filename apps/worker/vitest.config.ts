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
          // Test-only identity secrets (Platform §16). Real deployments set their own; see README.
          SESSION_SIGNING_KEY: "test-session-signing-key-0123456789abcdef",
          TOKEN_HASH_KEY: "test-token-hash-key-0123456789abcdefghijkl",
          PEPPER_1: "test-pepper-one-0123456789abcdefghijklmnopq",
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
