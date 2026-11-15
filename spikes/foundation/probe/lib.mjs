// Shared helpers for probe/deploy.mjs and probe/destroy.mjs.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..");
export const STATE_FILE = join(here, ".probe.json");
export const WORKER = "officebox-foundation-probe";
export const QUEUE = "officebox-foundation-probe";

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
    if (status !== 0) throw new Error(`wrangler queues list failed:\n${out}`);
    if (new RegExp(`(^|[\\s│|])${name}([\\s│|]|$)`, "m").test(out)) return true;
    if (!/[0-9a-f]{32}/.test(out)) return false; // no queue ids on this page: past the end
  }
  return false;
}

export function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}
