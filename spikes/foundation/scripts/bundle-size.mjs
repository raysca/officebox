// Q1/Q2: added bundle size of each candidate, measured with esbuild (minified, Workers conditions) and gzip.
// Each entry is a tiny Worker that uses only one candidate, compared against an empty Worker.
// Usage: npm run bundle-size
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENTRIES = {
  "empty Worker": `export default { fetch: () => new Response("ok") };`,
  "PBKDF2 (+ HMAC pepper), WebCrypto": `import { pbkdf2, pepperedPbkdf2 } from "./src/pbkdf2";
    export default { fetch: async () => Response.json([await pbkdf2("x", 100000), await pepperedPbkdf2("x", "p")]) };`,
  "Argon2id, hash-wasm + shim": `import { argon2 } from "./src/hash";
    export default { fetch: async () => Response.json(await argon2("x")) };`,
  "@simplewebauthn/server": `import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
    export default { fetch: async () => Response.json([generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse].map(String).length) };`,
};

const wasmBytes = (["argon2", "blake2b"]).reduce((n, f) => n + readFileSync(join(root, `src/wasm/${f}.wasm`)).length, 0);

const rows = [];
for (const [name, contents] of Object.entries(ENTRIES)) {
  const r = await build({
    stdin: { contents, resolveDir: root, loader: "ts" },
    bundle: true,
    minify: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["node:*", "*.wasm"],
  });
  const js = r.outputFiles[0].contents;
  const extraWasm = name.startsWith("Argon2") ? wasmBytes : 0;
  rows.push({ name, js: js.length, gzip: gzipSync(js).length, wasm: extraWasm });
}
const base = rows[0];
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log("candidate".padEnd(38), "minified JS".padStart(12), "gzip JS".padStart(10), "+ .wasm".padStart(10), "added (gzip JS + wasm)".padStart(24));
for (const r of rows) {
  console.log(r.name.padEnd(38), kib(r.js).padStart(12), kib(r.gzip).padStart(10), kib(r.wasm).padStart(10), kib(r.gzip - base.gzip + r.wasm).padStart(24));
}
