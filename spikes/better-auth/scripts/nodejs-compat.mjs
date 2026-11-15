// Q11: is nodejs_compat on by default on our compatibility date (2026-11-01), and does better-auth need it?
// Runs `wrangler dev` (workerd) on generated Worker configs with compatibility date 2026-11-01:
//   1. a probe Worker reporting what's there (process, process.getBuiltinModule, node:async_hooks import)
//   2. better-auth itself (create a user with the marker, read a session through our Kysely on D1)
// each with no flags, with nodejs_als only, and with nodejs_compat.
// Usage: node scripts/nodejs-compat.mjs
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const DATE = "2026-11-01";
const dir = join(process.cwd(), "node_modules", ".cache", "ba-spike", "compat");
mkdirSync(dir, { recursive: true });

const probe = `export default { async fetch() {
  const out = { typeofProcess: typeof globalThis.process, getBuiltinModule: typeof globalThis.process?.getBuiltinModule };
  try { const m = await import("node:async_hooks"); out.asyncHooksImport = typeof m.AsyncLocalStorage; } catch (e) { out.asyncHooksImport = "error: " + e.message; }
  out.bufferGlobal = typeof globalThis.Buffer;
  return Response.json(out);
} };`;

// Our schema, one statement per entry (comments stripped), applied by the Worker before it calls better-auth.
const schema = readFileSync(join(process.cwd(), "migrations", "0001_identity_baseline.sql"), "utf8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .split(";")
  .map((x) => x.trim())
  .filter(Boolean);

const authWorker = (
  await build({
    stdin: {
      contents: `
        import { createAuth } from "./src/auth.ts";
        import { requestStore } from "./src/context.ts";
        export default { async fetch(req, env) {
          try {
            await env.DB.batch(${JSON.stringify(schema)}.map((q) => env.DB.prepare(q)));
            const auth = createAuth(env, { workspaceName: "W", canonicalOrigin: "https://officebox.test" }, { db: "kysely-epoch" });
            const ctx = await auth.$context;
            const u = await requestStore.run({ create: { kind: "setup", attemptId: "a" } }, () =>
              ctx.internalAdapter.createUser({ email: crypto.randomUUID() + "@officebox.test", name: "c", emailVerified: true }, { method: "test" }));
            const s = await auth.api.getSession({ headers: new Headers() });
            return Response.json({ created: !!u, session: s });
          } catch (e) { return new Response("error: " + (e && e.message), { status: 500 }); }
        } };`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "error",
  })
).outputFiles[0].text;

writeFileSync(join(dir, "probe.mjs"), probe);
writeFileSync(join(dir, "auth.mjs"), authWorker);

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function run(main, flags, date = DATE) {
  const name = `${main.replace(".mjs", "")}-${flags.join("-") || "none"}-${date}`;
  const config = join(dir, `${name}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      name: "compat-probe",
      main,
      compatibility_date: date,
      compatibility_flags: flags,
      d1_databases: [{ binding: "DB", database_name: "compat", database_id: "00000000-0000-0000-0000-000000000001" }],
      vars: { BETTER_AUTH_SECRET: "s".repeat(48), TOKEN_HASH_KEY: "k".repeat(48) },
    }),
  );
  const port = await freePort();
  const child = spawn("npx", ["wrangler", "dev", "--config", config, "--port", String(port), "--ip", "127.0.0.1", "--persist-to", join(dir, `state-${name}`)], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) return `wrangler exited: ${log.split("\n").filter((l) => /error/i.test(l)).slice(0, 3).join(" | ")}`;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        return `${r.status} ${await r.text()}`;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    return "timeout";
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}

console.log(`control: probe on compatibility date 2024-09-01, no flags:`, await run("probe.mjs", [], "2024-09-01"));
console.log(`control: better-auth on 2024-09-01, no flags:`, (await run("auth.mjs", [], "2024-09-01")).slice(0, 300));
// Where the default flips: the better-auth docs say 2026-08-04.
for (const d of ["2026-08-03", "2026-08-04"]) console.log(`probe on ${d}, no flags:`, await run("probe.mjs", [], d));
console.log(`compatibility date ${DATE}`);
for (const flags of [[], ["nodejs_als"], ["nodejs_compat"]]) {
  console.log(`probe       [${flags.join(",") || "no flags"}]:`, await run("probe.mjs", flags));
}
for (const flags of [[], ["nodejs_als"], ["nodejs_compat"]]) {
  console.log(`better-auth [${flags.join(",") || "no flags"}]:`, (await run("auth.mjs", flags)).slice(0, 300));
}
