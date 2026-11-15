// Dependency check: published advisories (GitHub Advisory Database, through npm's bulk advisory endpoint, the source
// `npm audit` uses) against the pinned versions. Older better-auth versions are included as a control, so an empty
// result for the pins can't be mistaken for a broken query.
// Usage: node scripts/advisories.mjs
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const pinned = {};
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/") || meta.dev) continue;
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  (pinned[name] ??= new Set()).add(meta.version);
}
const body = Object.fromEntries(Object.entries(pinned).map(([k, v]) => [k, [...v]]));
const controlVersions = ["1.2.0", "1.6.10"];
body["better-auth"] = [...body["better-auth"], ...controlVersions];

const res = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
if (!res.ok) throw new Error(`advisory endpoint: ${res.status}`);
const advisories = await res.json();

const { satisfies } = await import("semver").catch(() => ({ satisfies: null }));
console.log(`checked ${Object.keys(pinned).length} runtime packages (production dependency tree from package-lock.json)`);
let hitsOnPins = 0;
for (const [pkg, list] of Object.entries(advisories)) {
  for (const a of list) {
    const affectedPins = [...(pinned[pkg] ?? [])].filter((v) => (satisfies ? satisfies(v, a.vulnerable_versions) : false));
    hitsOnPins += affectedPins.length;
    console.log(`${affectedPins.length ? "AFFECTS PIN" : "control only"}  ${pkg} ${a.vulnerable_versions.padEnd(24)} ${a.severity.padEnd(8)} ${a.url}  ${a.title.slice(0, 70)}`);
  }
}
console.log(hitsOnPins ? `\n${hitsOnPins} advisory hit(s) on pinned versions` : `\nno published advisory affects the pinned versions (better-auth ${[...pinned["better-auth"]].join(", ")}, @better-auth/passkey ${[...pinned["@better-auth/passkey"]].join(", ")})`);
