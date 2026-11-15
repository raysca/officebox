#!/usr/bin/env node
// Deploy preflight (TDD §6.5, step 1). Runs before `wrangler d1 migrations apply DB --remote` and
// `wrangler deploy`; any failure stops the deploy and the previous Worker version stays live.
//
// M0a checks what can be checked from the repository alone. Remote reachability of D1 is proven by
// the migrations step that follows; checks against release.json arrive with the release process.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

// Paths resolve from the repository root (this script's parent directory), whatever the cwd.
// Paths inside wrangler.jsonc are relative to that file, which also lives at the root.
const ROOT = resolve(import.meta.dirname, "..");
const fromRoot = (path) => join(ROOT, path);

const failures = [];
const notes = [];
const fail = (message) => failures.push(message);

/** Reads JSON, or JSONC the way wrangler does (comments and trailing commas allowed). */
function readJson(path, { jsonc = false } = {}) {
  let text;
  try {
    text = readFileSync(fromRoot(path), "utf8");
  } catch (error) {
    fail(`${path}: cannot be read (${error.message})`);
    return null;
  }
  if (!jsonc) {
    try {
      return JSON.parse(text);
    } catch (error) {
      fail(`${path}: cannot be parsed (${error.message})`);
      return null;
    }
  }
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first) {
    fail(`${path}: cannot be parsed (${printParseErrorCode(first.error)} at offset ${first.offset})`);
    return null;
  }
  return value;
}

const pkg = readJson("package.json");
const config = readJson("wrangler.jsonc", { jsonc: true });

if (pkg && config) {
  // Version reported by /health must match the release version.
  if (config.vars?.OFFICEBOX_VERSION !== pkg.version) {
    fail(
      `wrangler.jsonc vars.OFFICEBOX_VERSION (${config.vars?.OFFICEBOX_VERSION}) must equal package.json version (${pkg.version})`,
    );
  }

  // Required bindings.
  const d1 = (config.d1_databases ?? []).find((db) => db.binding === "DB");
  if (!d1) fail("wrangler.jsonc: D1 binding DB is missing");
  else if (!d1.database_id)
    notes.push("D1 database_id is not set yet; the Deploy button or `wrangler d1 create` provides it.");

  if (!(config.r2_buckets ?? []).some((b) => b.binding === "FILES"))
    fail("wrangler.jsonc: R2 binding FILES is missing");
  if (!(config.queues?.producers ?? []).some((q) => q.binding === "EMAIL_QUEUE")) {
    fail("wrangler.jsonc: queue producer EMAIL_QUEUE is missing");
  }
  for (const consumer of config.queues?.consumers ?? []) {
    if (!consumer.dead_letter_queue) fail(`wrangler.jsonc: queue consumer ${consumer.queue} has no dead_letter_queue`);
  }

  // Every Durable Object class is created by a migration.
  const migrated = new Set((config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []));
  for (const binding of config.durable_objects?.bindings ?? []) {
    if (!migrated.has(binding.class_name)) {
      fail(`wrangler.jsonc: Durable Object class ${binding.class_name} has no new_sqlite_classes migration`);
    }
  }

  // The web app must be built: Workers Assets uploads this directory.
  const assetsDir = config.assets?.directory;
  if (!assetsDir) fail("wrangler.jsonc: assets.directory is missing");
  else if (!existsSync(fromRoot(join(assetsDir, "index.html")))) {
    fail(`${assetsDir}/index.html not found: run \`npm run build\` before deploying`);
  }

  // D1 migrations: NNNN_<feature>_<change>.sql, numbered 0001 upwards with no gaps or duplicates (AGENTS §4.2).
  // The default matches wrangler's: ./migrations next to the config file.
  const migrationsDir = d1?.migrations_dir ?? "./migrations";
  if (!existsSync(fromRoot(migrationsDir))) fail(`${migrationsDir}: migrations directory not found`);
  else {
    const files = readdirSync(fromRoot(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    files.forEach((file, index) => {
      const match = /^(\d{4})_[a-z0-9]+_[a-z0-9_]+\.sql$/.exec(file);
      if (!match) fail(`${migrationsDir}/${file}: name must be NNNN_<feature>_<change>.sql`);
      else if (Number(match[1]) !== index + 1) {
        fail(`${migrationsDir}/${file}: expected number ${String(index + 1).padStart(4, "0")} (gap or duplicate)`);
      }
    });
    if (files.length === 0) fail(`${migrationsDir}: no migrations found`);
  }
}

for (const note of notes) console.log(`preflight: note: ${note}`);
if (failures.length > 0) {
  for (const message of failures) console.error(`preflight: FAIL: ${message}`);
  process.exit(1);
}
console.log("preflight: ok");
