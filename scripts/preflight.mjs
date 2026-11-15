#!/usr/bin/env node
// Deploy preflight (TDD §6.5, step 1). Runs before `wrangler d1 migrations apply DB --remote` and
// `wrangler deploy`; any failure stops the deploy and the previous Worker version stays live.
//
// M0a checks what can be checked from the repository alone. Remote reachability of D1 is proven by
// the migrations step that follows; checks against release.json arrive with the release process.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const failures = [];
const notes = [];
const fail = (message) => failures.push(message);

/** Strips // and /* *\/ comments from JSONC, leaving string contents alone. */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

function readJson(path, { jsonc = false } = {}) {
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(jsonc ? stripJsonComments(text) : text);
  } catch (error) {
    fail(`${path}: cannot be read or parsed (${error.message})`);
    return null;
  }
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
  else if (!existsSync(join(assetsDir, "index.html"))) {
    fail(`${assetsDir}/index.html not found: run \`npm run build\` before deploying`);
  }

  // D1 migrations: NNNN_<feature>_<change>.sql, numbered 0001 upwards with no gaps or duplicates (AGENTS §4.2).
  const migrationsDir = d1?.migrations_dir ?? "migrations";
  if (!existsSync(migrationsDir)) fail(`${migrationsDir}: migrations directory not found`);
  else {
    const files = readdirSync(migrationsDir)
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
