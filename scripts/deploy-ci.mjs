#!/usr/bin/env node
// Non-interactive deploy for GitHub Actions (.github/workflows/deploy.yml) and other CI.
//
// `npm run deploy` assumes the D1 database already exists: the Deploy button provisions it, and the
// manual path creates it by hand. CI deploys to an account that may be fresh, so this script makes
// the first run work too, without writing resource IDs into wrangler.jsonc:
//
//   1. preflight (scripts/preflight.mjs)
//   2. ensure the D1 database exists, looked up by database_name; create it if it doesn't
//   3. wrangler d1 migrations apply DB --remote   (wrangler resolves the database by name)
//   4. wrangler deploy                            (wrangler provisions R2 and the queues by name)
//
// Migrations run before the new Worker version goes live (expand/contract, TDD §6.5). Any failure
// stops the run and the previous Worker version stays live.
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment. Never prints either.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

const ROOT = resolve(import.meta.dirname, "..");

function fail(message) {
  console.error(`deploy: FAIL: ${message}`);
  process.exit(1);
}

for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (!process.env[name]) fail(`${name} is not set`);
}

/** Runs a command from the repository root. `capture` returns its output instead of streaming it. */
function run(command, args, { capture = false } = {}) {
  console.log(`deploy: $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
  if (result.error) fail(`${command} could not start (${result.error.message})`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const wrangler = (args, options) => run("npx", ["--no-install", "wrangler", ...args], options);

// 1. Preflight.
if (run("node", ["scripts/preflight.mjs"]).status !== 0) fail("preflight failed");

// 2. Ensure the database exists.
const config = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"), [], { allowTrailingComma: true });
const db = (config.d1_databases ?? []).find((d) => d.binding === "DB");
if (!db?.database_name) fail("wrangler.jsonc: D1 binding DB has no database_name");

if (db.database_id) {
  console.log(`deploy: D1 database_id is set in wrangler.jsonc; using it`);
} else {
  const info = wrangler(["d1", "info", db.database_name, "--json"], { capture: true });
  if (info.status === 0) {
    console.log(`deploy: D1 database ${db.database_name} exists`);
  } else if (/couldn't find|not found|7404/i.test(info.stdout + info.stderr)) {
    console.log(`deploy: D1 database ${db.database_name} not found; creating it`);
    if (wrangler(["d1", "create", db.database_name, "--update-config=false"]).status !== 0) {
      fail(`could not create D1 database ${db.database_name}`);
    }
  } else {
    process.stderr.write(info.stderr);
    fail(`could not look up D1 database ${db.database_name} (check the API token's D1 permission)`);
  }
}

// 3. Migrations, then 4. the new Worker version.
if (wrangler(["d1", "migrations", "apply", "DB", "--remote"]).status !== 0) fail("D1 migrations failed");
if (wrangler(["deploy"]).status !== 0) fail("wrangler deploy failed");
console.log("deploy: ok");
