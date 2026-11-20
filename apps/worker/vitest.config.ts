import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import ts from "typescript";
import { z } from "zod";

// Worker integration tests run inside the Workers runtime (Miniflare) with the real wrangler.jsonc
// bindings. Proven configuration from spikes/realtime.
//
// `main` is a test entry that re-exports the real Worker plus test-only Durable Object classes
// (test/fixtures), bound below. Production code and wrangler.jsonc never see them.
/** `ratelimits` from wrangler.jsonc (a JSONC file, so read with TypeScript's comment-aware parser). */
function declaredRateLimits() {
  const path = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
  // `config` is typed `any`; the schema below checks it.
  const parsed: { config?: unknown; error?: ts.Diagnostic } = ts.parseConfigFileTextToJson(
    path,
    readFileSync(path, "utf8"),
  );
  const { config, error } = parsed;
  if (error) throw new Error(`wrangler.jsonc: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  const schema = z.object({
    ratelimits: z.array(
      z.object({ name: z.string(), simple: z.object({ limit: z.number().int(), period: z.number().int() }) }),
    ),
  });
  return schema.parse(config).ratelimits.map(({ name, simple }) => ({ name, simple }));
}

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
          // The declared rate limits, so tests with an injected-clock limiter (test/fake-rate-limit.ts)
          // count against the deployed configuration.
          TEST_RATE_LIMITS: declaredRateLimits(),
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
