// Q (dependencies): bundle size of better-auth + the passkey plugin, measured with esbuild (minified, Workers
// conditions, node:* external as with nodejs_compat) and gzip, plus a per-package breakdown from the metafile.
// `npx wrangler deploy --dry-run --minify` gives the authoritative upload size; the README records both.
// Usage: npm run bundle-size
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

const ENTRIES = {
  "empty Worker": `export default { fetch: () => new Response("ok") };`,
  "Hono only": `import { Hono } from "hono"; const app = new Hono(); app.get("/", (c) => c.text("ok")); export default app;`,
  "better-auth (full) + magicLink + passkey": `import { betterAuth } from "better-auth"; import { magicLink } from "better-auth/plugins/magic-link"; import { passkey } from "@better-auth/passkey";
    export default { fetch: (r, env) => betterAuth({ database: env.DB, plugins: [magicLink({ sendMagicLink: async () => {} }), passkey()] }).handler(r) };`,
  "better-auth/minimal + kysely adapter + magicLink + passkey": `import { betterAuth } from "better-auth/minimal"; import { kyselyAdapter } from "@better-auth/kysely-adapter"; import { magicLink } from "better-auth/plugins/magic-link"; import { passkey } from "@better-auth/passkey";
    export default { fetch: (r, env) => betterAuth({ database: kyselyAdapter(env.KYSELY, { type: "sqlite" }), plugins: [magicLink({ sendMagicLink: async () => {} }), passkey()] }).handler(r) };`,
  "the whole spike Worker (src/index.ts)": `export { default } from "./src/index.ts";`,
};

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
const rows = [];
let spikeMeta;
for (const [name, contents] of Object.entries(ENTRIES)) {
  const r = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    minify: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "error",
  });
  const js = r.outputFiles[0].contents;
  rows.push({ name, min: js.length, gzip: gzipSync(js).length });
  if (name.startsWith("the whole")) spikeMeta = r.metafile;
}
console.log("entry".padEnd(60), "minified".padStart(12), "gzip".padStart(10));
for (const r of rows) console.log(r.name.padEnd(60), kib(r.min).padStart(12), kib(r.gzip).padStart(10));

// Per-package contribution in the whole spike Worker (bytes of minified output attributed to each input).
const byPkg = new Map();
for (const out of Object.values(spikeMeta.outputs)) {
  for (const [input, { bytesInOutput }] of Object.entries(out.inputs)) {
    const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    const pkg = m ? m[1] : "(spike source)";
    byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + bytesInOutput);
  }
}
console.log("\nlargest packages in the spike Worker (minified bytes):");
for (const [pkg, n] of [...byPkg].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log("  " + pkg.padEnd(40), kib(n).padStart(10));
