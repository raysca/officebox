import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Storage is shared between tests in a file: tests create their own unique IDs (AGENTS §5).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
