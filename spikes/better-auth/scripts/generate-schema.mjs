// Q1: the SQL better-auth generates for our configuration, from getMigrations() run programmatically (the same code
// `npx auth generate` / `migrate` use for the Kysely adapter), against an empty SQLite database.
//   1. better-auth's default names (no mapping)
//   2. our mapped names (src/auth.ts buildAuthOptions), the source of migrations/0001_identity_baseline.sql
//   3. a diff against our hand-written migration: what getMigrations would still add (should be nothing)
// Usage: npm run schema
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Bundled into node_modules/.cache so the bundle's bare imports resolve against this package's node_modules.
const entry = join(process.cwd(), "node_modules", ".cache", "ba-spike", "schema-entry.mjs");
await build({
  stdin: {
    contents: `export { buildAuthOptions } from "./src/auth.ts"; export { getMigrations } from "better-auth/db/migration";
               export { passkey } from "@better-auth/passkey"; export { magicLink } from "better-auth/plugins/magic-link";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: entry,
  packages: "external",
  logLevel: "error",
});
const { buildAuthOptions, getMigrations, passkey, magicLink } = await import(pathToFileURL(entry).href);

const fakeEnv = { DB: null, BETTER_AUTH_SECRET: "x".repeat(40), TOKEN_HASH_KEY: "y".repeat(40) };
const inst = { workspaceName: "Spike", canonicalOrigin: "https://officebox.test" };

async function sqlFor(options, db) {
  const { compileMigrations, toBeCreated, toBeAdded } = await getMigrations({ ...options, database: db });
  return { sql: await compileMigrations(), toBeCreated: toBeCreated.map((t) => t.table), toBeAdded: toBeAdded.map((t) => `${t.table}: ${Object.keys(t.fields).join(", ")}`) };
}

// 1. Defaults: same plugins, no model/field mapping
const defaults = await sqlFor(
  { secret: "x".repeat(40), baseURL: inst.canonicalOrigin, plugins: [magicLink({ sendMagicLink: async () => {} }), passkey()] },
  new DatabaseSync(":memory:"),
);
console.log("=== 1. better-auth defaults (tables: " + defaults.toBeCreated.join(", ") + ") ===\n" + defaults.sql);

// 2. Ours
const ours = buildAuthOptions(fakeEnv, inst, {});
const mapped = await sqlFor(ours, new DatabaseSync(":memory:"));
console.log("\n=== 2. our mapping (tables: " + mapped.toBeCreated.join(", ") + ") ===\n" + mapped.sql);

// 3. Against our hand-written migration
const db = new DatabaseSync(":memory:");
db.exec(readFileSync(join(process.cwd(), "migrations", "0001_identity_baseline.sql"), "utf8"));
const diff = await sqlFor(ours, db);
console.log("\n=== 3. what getMigrations would change on top of migrations/0001 ===");
console.log(diff.toBeCreated.length || diff.toBeAdded.length ? JSON.stringify(diff, null, 2) : "nothing: the hand-written schema matches better-auth's expectations");
