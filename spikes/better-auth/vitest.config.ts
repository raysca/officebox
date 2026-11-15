import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs inside workerd (Miniflare) with this spike's wrangler.jsonc: compatibility date 2026-11-01, nodejs_compat, D1.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          BETTER_AUTH_SECRET: "spike-secret-0123456789abcdef0123456789abcdef-AAAA",
          TOKEN_HASH_KEY: "spike-token-hash-key-0123456789abcdef0123456789",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
