// Starts `wrangler dev` for the spike Worker and waits until it answers.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export async function startDevServer(port = 8787) {
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--var", `RP_ORIGIN:http://localhost:${port}`, "--show-interactive-dev-session=false"],
    { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  // npx -> wrangler -> workerd: signal the whole process group, or workerd outlives us.
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`);
    try {
      const r = await fetch(`${base}/`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      killGroup("SIGKILL");
      throw new Error(`wrangler dev did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    base,
    log: () => log,
    stop: () =>
      new Promise((res) => {
        if (child.exitCode !== null) return res();
        child.once("exit", res);
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 5000).unref();
      }),
  };
}
