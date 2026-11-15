// Starts `wrangler dev` for the spike Worker on a free port, with a fresh local D1 (migrations applied), and waits
// until it answers. Adapted from spikes/foundation/scripts/lib/dev-server.mjs.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
// Local test values only (never real secrets).
const VARS = {
  BETTER_AUTH_SECRET: "spike-secret-0123456789abcdef0123456789abcdef-AAAA",
  TOKEN_HASH_KEY: "spike-token-hash-key-0123456789abcdef0123456789",
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startDevServer({ timeoutMs = 90_000 } = {}) {
  const persist = mkdtempSync(join(tmpdir(), "ba-spike-"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  const port = await freePort();
  const args = ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false"];
  for (const [k, v] of Object.entries(VARS)) args.push("--var", `${k}:${v}`);
  const child = spawn("npx", args, { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  const stop = () =>
    new Promise((res) => {
      if (child.exitCode !== null) return res();
      child.once("exit", res);
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000).unref();
    });
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited with ${child.exitCode}\n${log.slice(-3000)}`);
    try {
      const r = await fetch(`${base}/`);
      if (r.ok) return { base, log: () => log, stop };
    } catch {}
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`wrangler dev did not answer within ${timeoutMs / 1000} s\n${log.slice(-3000)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
