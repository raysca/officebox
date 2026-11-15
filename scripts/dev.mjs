#!/usr/bin/env node
// Local development: `wrangler dev` (Worker, Durable Objects, D1, queues) on 127.0.0.1:8787 and the
// Vite dev server (web app with hot reload) on :5173. Vite proxies /api and /health to the Worker, so
// open http://localhost:5173. Ctrl+C stops both. Set WORKER_PORT to move the Worker off 8787.
//
// Works on macOS, Linux and Windows: the long-running tools are started directly with Node (no
// intermediate shell), so stopping a child stops the tool itself.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
const WEB = join(ROOT, "apps", "web");

const workerPort = process.env.WORKER_PORT ?? "8787";
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  WORKER_ORIGIN: `http://127.0.0.1:${workerPort}`,
};

function runOnce(args, cwd = ROOT) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Wrangler serves Workers Assets from apps/web/dist and refuses to start without it.
if (!existsSync(join(WEB, "dist", "index.html"))) runOnce([VITE, "build"], WEB);

// Keep the local D1 database at the latest schema.
runOnce([WRANGLER, "d1", "migrations", "apply", "DB", "--local"]);

const start = (args, cwd) => spawn(process.execPath, args, { stdio: "inherit", cwd, env });
const children = [start([WRANGLER, "dev", "--ip", "127.0.0.1", "--port", workerPort], ROOT), start([VITE], WEB)];

function terminate(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    // Windows has no SIGTERM; end the whole process tree (wrangler starts workerd).
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) terminate(child);
  process.exitCode = code;
}

for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
