// Q4: every place in the pinned better-auth + passkey code that can insert a `user` row, and whether it goes through
// the hooked create (createWithHooks → databaseHooks.user.create.before). Static scan of the installed dist files.
//   - internalAdapter.createUser / createOAuthUser → createWithHooks(…, "user") (hooked)
//   - a raw adapter.create({ model: "user" }) would bypass the hooks: the scan looks for those too
// Usage: node scripts/creation-paths.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["node_modules/better-auth/dist", "node_modules/@better-auth/core/dist", "node_modules/@better-auth/passkey/dist"];
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".mjs")) files.push(p);
  }
};
roots.forEach(walk);

const ENABLED_PLUGINS = ["magic-link"]; // plus @better-auth/passkey; every other plugin is not loaded
const hits = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const hooked = /internalAdapter\.createUser\(|internalAdapter\.createOAuthUser\(|createOAuthUser\(/.test(line) && !/^\s*(\/\/|\*)/.test(line);
    const window = lines.slice(i, i + 3).join(" ");
    const raw = /\.create\(\{/.test(line) && /model:\s*"user"/.test(window);
    if (hooked || raw) {
      const rel = relative("node_modules", f);
      const plugin = rel.match(/plugins\/([^/]+)\//)?.[1];
      const reachable = plugin ? ENABLED_PLUGINS.includes(plugin) : !rel.includes("test-utils");
      hits.push({ file: `${rel}:${i + 1}`, kind: raw ? "RAW adapter.create (bypasses hooks)" : "hooked (createWithHooks)", reachable: reachable ? "loaded" : `not loaded (${plugin ?? "test utils"})`, code: line.trim().slice(0, 110) });
    }
  });
}
// The internal adapter's own definitions, for the record: both end in createWithHooks(…, "user").
const ia = readFileSync("node_modules/better-auth/dist/db/internal-adapter.mjs", "utf8");
console.log("internal-adapter createUser → createWithHooks:", /createUser: async[\s\S]{0,1500}?createWithHooks\(data, "user"/.test(ia));
console.log("internal-adapter createOAuthUser → createWithHooks:", /createOAuthUser: async[\s\S]{0,300}?createWithHooks\(/.test(ia));
console.log("\nuser-creating call sites:");
for (const h of hits.filter((h) => h.reachable === "loaded")) console.log(`  [${h.kind}] ${h.file}\n      ${h.code}`);
console.log(`\n(${hits.filter((h) => h.reachable !== "loaded").length} more in plugins we don't load: ${[...new Set(hits.filter((h) => h.reachable !== "loaded").map((h) => h.reachable))].join(", ")})`);
const rawLoaded = hits.filter((h) => h.reachable === "loaded" && h.kind.startsWith("RAW"));
console.log(rawLoaded.length ? `\nWARNING: ${rawLoaded.length} raw user insert(s) in loaded code` : "\nno raw user inserts in loaded code: every path runs databaseHooks.user.create.before");
