// Deploys the production probe to your Cloudflare account. Usage: npm run deploy:probe
// Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN) first. Creates the probe queue if missing, generates a
// random PROBE_TOKEN, deploys, and saves { url, token } to probe/.probe.json (git-ignored) for check.mjs.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const run = (args, { allowFail = false } = {}) => {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (r.status !== 0 && !allowFail) process.exit(r.status ?? 1);
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

run(["queues", "create", "officebox-foundation-probe"], { allowFail: true }); // "already exists" is fine
const token = randomBytes(24).toString("base64url");
const out = run(["deploy", "--config", "probe/wrangler.jsonc", "--var", `PROBE_TOKEN:${token}`]);
const url = out.match(/https:\/\/officebox-foundation-probe\.[\w.-]+\.workers\.dev/)?.[0];
if (!url) {
  console.error("Deployed, but couldn't find the workers.dev URL in the output. Run: npm run check:probe -- --url=https://...");
}
writeFileSync(join(here, ".probe.json"), JSON.stringify({ url, token }, null, 2));
console.log(`\nProbe deployed${url ? ` at ${url}` : ""}. Now run: npm run check:probe`);
