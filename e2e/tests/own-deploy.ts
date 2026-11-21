import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { E2E_VARS } from "./fixtures";

/**
 * A fresh deploy of its own for one spec file (M1e): an empty D1 in a new directory, migrated, served by
 * `wrangler dev` on `E2E_PORT + slot`, with the test email sink and every Rate Limiting binding raised
 * (all browsers share one IP; the limits themselves are covered by the Worker integration tests). The
 * same approach as m1c.spec.ts, as a helper. The config copy lives under the git-ignored `.wrangler/`
 * and is only ever passed to this local `wrangler dev`.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");

export interface OwnDeploy {
  origin: string;
  /** Runs SQL against this deploy's local D1 and returns the rows. */
  d1(sql: string): Record<string, unknown>[];
  stop(): Promise<void>;
}

function testConfig(name: string): string {
  const source = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  const pattern = /"simple": \{ "limit": \d+, "period": (10|60) \}/g;
  const bindings = source.match(/"name": "[A-Z_]+_RATE_LIMITER"/g) ?? [];
  const matched = source.match(pattern) ?? [];
  if (bindings.length === 0 || matched.length !== bindings.length) {
    throw new Error(
      `expected every rate-limit binding to be raised; ${bindings.length} bindings, ${matched.length} limits`,
    );
  }
  const raised = source.replace(pattern, '"simple": { "limit": 1000, "period": $1 }');
  const absolute = raised
    .replace('"main": "apps/worker/src/index.ts"', `"main": ${JSON.stringify(join(ROOT, "apps/worker/src/index.ts"))}`)
    .replace('"directory": "apps/web/dist"', `"directory": ${JSON.stringify(join(ROOT, "apps/web/dist"))}`)
    .replace(
      '"migrations_dir": "apps/worker/migrations"',
      `"migrations_dir": ${JSON.stringify(join(ROOT, "apps/worker/migrations"))}`,
    );
  const dir = join(ROOT, ".wrangler", "e2e");
  mkdirSync(dir, { recursive: true });
  const prefix = new RegExp(`^${name}-\\d+\\.jsonc$`);
  for (const file of readdirSync(dir)) if (prefix.test(file)) rmSync(join(dir, file), { force: true });
  const path = join(dir, `${name}-${process.pid}.jsonc`);
  writeFileSync(path, absolute);
  return path;
}

export async function startOwnDeploy({
  name,
  slot,
  vars = {},
}: {
  name: string;
  slot: number;
  vars?: Record<string, string>;
}): Promise<OwnDeploy> {
  const port = Number(process.env.E2E_PORT ?? 8788) + slot;
  const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, "127.0.0.1", "localhost", ".localhost"]
    .filter(Boolean)
    .join(",");
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: noProxy, no_proxy: noProxy };
  const state = mkdtempSync(join(tmpdir(), `officebox-e2e-${name}-`));
  const config = testConfig(name);
  execFileSync(
    "npx",
    ["wrangler", "--config", config, "d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
    {
      cwd: ROOT,
      stdio: "pipe",
      env,
    },
  );
  const varArgs = Object.entries({ ...E2E_VARS, ...vars }).flatMap(([key, value]) => ["--var", `${key}:${value}`]);
  const child: ChildProcess = spawn(
    "npx",
    [
      "wrangler",
      "--config",
      config,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(port + 1000),
      "--show-interactive-dev-session=false",
      "--persist-to",
      state,
      ...varArgs,
    ],
    { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200 || res.status === 503) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`wrangler dev didn't start:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    origin: `http://localhost:${port}`,
    d1(sql: string) {
      const output = execFileSync(
        "npx",
        [
          "wrangler",
          "--config",
          config,
          "d1",
          "execute",
          "DB",
          "--local",
          "--persist-to",
          state,
          "--json",
          "--command",
          sql,
        ],
        { cwd: ROOT, stdio: "pipe", env },
      ).toString();
      const parsed = JSON.parse(output) as { results: Record<string, unknown>[] }[];
      return parsed[0]?.results ?? [];
    },
    async stop() {
      const pid = child.pid;
      rmSync(config, { force: true });
      if (pid === undefined) return;
      const exited = child.exitCode !== null ? Promise.resolve() : new Promise((r) => child.once("exit", r));
      const signal = (sig: NodeJS.Signals) => {
        try {
          process.kill(-pid, sig);
        } catch {
          // already gone
        }
      };
      signal("SIGTERM");
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), 10_000)),
      ]);
      if (timedOut) signal("SIGKILL");
    },
  };
}
