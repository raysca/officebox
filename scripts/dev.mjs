#!/usr/bin/env node
// Local development: `wrangler dev` (Worker, Durable Objects, D1, queues) on :8787 and the Vite dev
// server (web app with hot reload) on :5173. Vite proxies /api and /health to the Worker, so open
// http://localhost:5173. Ctrl+C stops both. Set WORKER_PORT to move the Worker off :8787.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const workerPort = process.env.WORKER_PORT ?? "8787";
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  WORKER_ORIGIN: `http://localhost:${workerPort}`,
};

function runOnce(command) {
  const result = spawnSync(command, { stdio: "inherit", shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Wrangler serves Workers Assets from apps/web/dist and refuses to start without it.
if (!existsSync("apps/web/dist/index.html")) runOnce("npm run build -w @officebox/web");

// Keep the local D1 database at the latest schema.
runOnce("npx wrangler d1 migrations apply DB --local");

// Each child gets its own process group so stopping it also stops the processes npx and npm start.
const start = (command) => spawn(command, { stdio: "inherit", shell: true, env, detached: true });
const children = [start(`npx wrangler dev --port ${workerPort}`), start("npm run dev -w @officebox/web")];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }
  process.exit(code);
}

for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
