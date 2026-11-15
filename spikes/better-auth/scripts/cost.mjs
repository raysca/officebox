// Q12: CPU cost of building a per-installation better-auth instance and of a session read, measured in Node (V8, same
// engine as workerd; workerd's clocks don't advance during CPU work, so tests can't time it). The database is an
// in-memory SQLite (node:sqlite) with our schema, so this is library CPU, not D1 latency.
// Usage: node scripts/cost.mjs
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const entry = join(process.cwd(), "node_modules", ".cache", "ba-spike", "cost-entry.mjs");
await build({
  stdin: {
    contents: `export { buildAuthOptions } from "./src/auth.ts"; export { requestStore } from "./src/context.ts"; export { betterAuth } from "better-auth";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: entry,
  packages: "external",
  logLevel: "error",
});
const { buildAuthOptions, requestStore, betterAuth } = await import(pathToFileURL(entry).href);

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(join(process.cwd(), "migrations", "0001_identity_baseline.sql"), "utf8"));
// A minimal D1-shaped wrapper for the hooks' own queries (prepare/bind/first/run/all).
const d1 = {
  prepare(sql) {
    let args = [];
    const st = {
      bind: (...a) => ((args = a), st),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    };
    return st;
  },
};
const env = { DB: d1, BETTER_AUTH_SECRET: "s".repeat(48), TOKEN_HASH_KEY: "k".repeat(48) };
const make = (i, validateSchema) => {
  const o = buildAuthOptions(env, { workspaceName: "W", canonicalOrigin: `https://w${i}.officebox.test` });
  return betterAuth({
    ...o,
    database: db,
    rateLimit: { enabled: false },
    advanced: { ...o.advanced, database: { ...o.advanced.database, validateSchema } },
  });
};
const cpu = async (fn) => {
  const a = process.cpuUsage();
  const t = performance.now();
  await fn();
  const b = process.cpuUsage(a);
  return { cpuMs: (b.user + b.system) / 1000, wallMs: performance.now() - t };
};

// warm the module graph and JIT once
await make(-1, false).$context;

const N = 30;
for (const validateSchema of [false, true]) {
  const ctor = [];
  const init = [];
  for (let i = 0; i < N; i++) {
    let auth;
    ctor.push((await cpu(async () => (auth = make(i, validateSchema)))).cpuMs);
    init.push((await cpu(async () => requestStore.run({}, () => auth.api.getSession({ headers: new Headers({ cookie: "x=y" }) })))).cpuMs);
  }
  const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(2);
  console.log(`new instance (validateSchema ${validateSchema}): betterAuth() ${med(ctor)} ms CPU, first request (context init${validateSchema ? " + schema check" : ""}) ${med(init)} ms CPU  [median of ${N}]`);
}

// a session read on a warm instance
const auth = make(999, false);
const ctx = await auth.$context;
const user = await requestStore.run({ create: { kind: "setup", attemptId: "a" } }, () =>
  ctx.internalAdapter.createUser({ email: "cost@officebox.test", name: "c", emailVerified: true }, { method: "test" }),
);
const session = await requestStore.run({}, () => ctx.internalAdapter.createSession(user.id));
const sign = async (v) => {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(v))).toString("base64");
  return encodeURIComponent(`${v}.${sig}`);
};
const cookie = `__Host-officebox.session_token=${await sign(session.token)}`;
const ok = await requestStore.run({}, () => auth.api.getSession({ headers: new Headers({ cookie }) }));
if (!ok) throw new Error("session read failed");
const reads = [];
for (let i = 0; i < 200; i++) reads.push((await cpu(() => requestStore.run({}, () => auth.api.getSession({ headers: new Headers({ cookie }) })))).cpuMs);
reads.sort((a, b) => a - b);
console.log(`getSession on a warm instance: median ${reads[100].toFixed(3)} ms CPU, p95 ${reads[190].toFixed(3)} ms  [200 reads; plus 2 D1 queries in the Worker]`);
