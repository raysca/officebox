// Starts `wrangler dev` for the spike Worker on a free port and waits until it answers.
// Retries the start once (wrangler occasionally fails to bind or build on a cold start) and prints the tail of
// wrangler's log when it gives up.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function freePort() {
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

async function startOnce(port, timeoutMs) {
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--var", `RP_ORIGIN:http://localhost:${port}`, "--show-interactive-dev-session=false"],
    // detached: own process group, so stop() can signal npx -> wrangler -> workerd together.
    { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
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
    if (child.exitCode !== null) return { error: `wrangler dev exited with ${child.exitCode}`, log };
    try {
      const r = await fetch(`${base}/`);
      if (r.ok) return { server: { base, log: () => log, stop } };
    } catch {}
    if (Date.now() > deadline) {
      await stop();
      return { error: `wrangler dev did not answer within ${timeoutMs / 1000} s`, log };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function startDevServer({ port, timeoutMs = 60_000, attempts = 2 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    const p = port ?? (await freePort());
    const r = await startOnce(p, timeoutMs);
    if (r.server) return r.server;
    last = r;
    console.error(`[dev-server] attempt ${i}/${attempts} on port ${p} failed: ${r.error}\n--- wrangler log (tail) ---\n${r.log.slice(-3000)}\n---`);
  }
  throw new Error(`wrangler dev could not be started: ${last.error}`);
}
