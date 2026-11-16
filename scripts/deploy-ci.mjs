#!/usr/bin/env node
// Non-interactive deploy for GitHub Actions (.github/workflows/deploy.yml) and other CI.
//
// `npm run deploy` assumes the D1 database already exists: the Deploy button provisions it, and the
// manual path creates it by hand. CI deploys to an account that may be fresh, so this script makes
// the first run work too, without writing resource IDs into wrangler.jsonc:
//
//   1. preflight (scripts/preflight.mjs)
//   2. ensure the D1 database exists (exact name match in `wrangler d1 list`); create it if it doesn't
//   3. wrangler d1 migrations apply DB --remote   (wrangler resolves the database by name)
//   4. ensure the required random secrets exist   (BETTER_AUTH_SECRET, TOKEN_HASH_KEY)
//   5. wrangler deploy                            (wrangler provisions R2 and the queues by name)
//
// Step 4 (default): a missing generated secret is created with 32 random bytes from node:crypto,
// piped to `wrangler secret put` on stdin. Values are never printed, logged or written to disk, and
// an existing secret is never overwritten. They then live only in Cloudflare. On a fresh account the
// Worker doesn't exist yet: `wrangler secret put` creates a draft Worker to hold the secrets, and
// `wrangler deploy` replaces its code while keeping them (wrangler deploys with keepSecrets).
//
// Migrations run before the new Worker version goes live (expand/contract, TDD §6.5). Any failure
// stops the run and the previous Worker version stays live (migrations may be partly applied).
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment. Never prints either.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import {
  GENERATED_SECRETS,
  createdSecretWarning,
  generateSecretValue,
  isWorkerNotFound,
  parseSecretList,
  secretsToCreate,
} from "./ensure-secrets.mjs";

const ROOT = resolve(import.meta.dirname, "..");
process.env.WRANGLER_SEND_METRICS ??= "false";

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
    env: { ...process.env, CI: "true" },
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
  // Exact name match against the account's database list: no error-text matching, so a lookup
  // failure (wrong account, missing permission, outage) stops the deploy instead of creating a database.
  const list = wrangler(["d1", "list", "--json"], { capture: true });
  if (list.status !== 0) {
    process.stderr.write(list.stderr);
    fail("could not list D1 databases (check CLOUDFLARE_ACCOUNT_ID and the API token's D1 permission)");
  }
  let databases;
  try {
    databases = JSON.parse(list.stdout);
  } catch {
    fail("could not parse `wrangler d1 list --json` output");
  }
  if (!Array.isArray(databases)) fail("unexpected `wrangler d1 list --json` output");
  if (databases.some((d) => d?.name === db.database_name)) {
    console.log(`deploy: D1 database ${db.database_name} exists`);
  } else {
    console.log(`deploy: D1 database ${db.database_name} not found; creating it`);
    if (wrangler(["d1", "create", db.database_name, "--update-config=false"]).status !== 0) {
      fail(`could not create D1 database ${db.database_name}`);
    }
  }
}

// 3. Migrations.
if (wrangler(["d1", "migrations", "apply", "DB", "--remote"]).status !== 0) fail("D1 migrations failed");

// 4. Ensure the required random secrets exist, before the code that needs them goes live.
if (!config.name) fail("wrangler.jsonc has no Worker name");
await ensureSecrets(config.name);

// 5. The new Worker version.
if (wrangler(["deploy"]).status !== 0) fail("wrangler deploy failed");
console.log("deploy: ok");

/**
 * Whether the Worker exists, asked of the Cloudflare API directly so the answer comes from a
 * structured error code (10007: not found), never from wrangler's message text. Called only after
 * `wrangler secret list` has failed.
 */
async function workerMissing(name) {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}` +
    `/workers/scripts/${encodeURIComponent(name)}/secrets`;
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
  } catch (error) {
    fail(`could not reach the Cloudflare API to check the Worker (${error.message})`);
  }
  const body = await response.json().catch(() => null);
  return response.status === 404 && isWorkerNotFound(body);
}

async function ensureSecrets(name) {
  const list = wrangler(["secret", "list", "--format", "json"], { capture: true });
  let existing;
  if (list.status === 0) {
    existing = parseSecretList(list.stdout);
    if (existing === null) fail("could not parse `wrangler secret list --format json` output");
  } else if (await workerMissing(name)) {
    console.log(`deploy: Worker ${name} doesn't exist yet; its secrets are created with it`);
    existing = [];
  } else {
    process.stderr.write(list.stderr);
    fail("could not list Worker secrets (check the API token's Workers Scripts permission)");
  }
  const missing = new Set(secretsToCreate(existing));
  for (const secret of GENERATED_SECRETS) {
    if (!missing.has(secret)) {
      console.log(`deploy: ${secret} already set`);
      continue;
    }
    const value = generateSecretValue();
    // The value goes only to wrangler's stdin. Output is captured, and shown only on failure with any
    // occurrence of the value removed (wrangler doesn't echo it, but never rely on that).
    const result = spawnSync("npx", ["--no-install", "wrangler", "secret", "put", secret], {
      cwd: ROOT,
      input: value,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      // Wrangler's own log sanitising on, at its normal level, whatever the runner's environment says.
      env: { ...process.env, CI: "true", WRANGLER_LOG_SANITIZE: "true", WRANGLER_LOG: "log" },
    });
    if (result.error || result.status !== 0) {
      const scrub = (text) => (text ?? "").split(value).join("[redacted]");
      process.stderr.write(scrub(result.stdout) + scrub(result.stderr));
      fail(`could not create ${secret}`);
    }
    console.log(`deploy: created ${secret}`);
    console.warn(createdSecretWarning(secret));
  }
}
