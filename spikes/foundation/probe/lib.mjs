// Shared helpers for probe/deploy.mjs, probe/destroy.mjs and probe/check.mjs.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..");
export const STATE_FILE = join(here, ".probe.json");
export const WORKER = "officebox-foundation-probe";
export const QUEUE = "officebox-foundation-probe";

export function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

/** Runs `npx wrangler <args>` from the spike root. Returns { status, out }; prints output unless quiet. */
export function wrangler(args, { input, quiet = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!quiet) process.stdout.write(out);
  return { status: r.status ?? 1, out };
}

/** True if the account already has a queue with this exact name (walks `wrangler queues list` pages). */
export function queueExists(name) {
  for (let page = 1; page <= 20; page++) {
    const { status, out } = wrangler(["queues", "list", "--page", String(page)], { quiet: true });
    if (status !== 0) fail(`Listing queues failed, so the probe can't check for an existing "${name}" queue:\n${out.slice(-2000)}`);
    if (new RegExp(`(^|[\\s│|])${name}([\\s│|]|$)`, "m").test(out)) return true;
    if (!/[0-9a-f]{32}/.test(out)) return false; // no queue ids on this page: past the end
  }
  return false;
}

/**
 * True if a Worker with this name exists in the account. Only Cloudflare's "worker not found" API error (code
 * 10007, "This Worker does not exist") counts as absent; any other failure (wrong account, auth, network, npx)
 * stops the script rather than risk deploying over, and later deleting, an existing Worker.
 */
export function workerExists(name) {
  const { status, out } = wrangler(["deployments", "list", "--name", name, "--json"], { quiet: true });
  if (status === 0) return true;
  if (/\b10007\b/.test(out) || /This Worker does not exist/.test(out)) return false;
  fail(`Couldn't tell whether a Worker "${name}" exists, so nothing was changed:\n${out.slice(-2000)}`);
}

/** Parsed probe/.probe.json, or null if absent. A corrupt file stops the script with a clear message. */
export function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("not a JSON object");
    return state;
  } catch (e) {
    fail(`probe/.probe.json is unreadable (${e.message}). Inspect or delete it; nothing was changed.`);
  }
}

/** State holds the probe token, so it is written owner-read/write only. */
export function writeState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600); // writeFileSync's mode only applies when the file is created
}
