// Deploys the production probe to your Cloudflare account. Usage: npm run deploy:probe [-- --reuse-queue]
//
// Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN) first. Steps:
//   1. refuses if a queue named officebox-foundation-probe already exists (unless --reuse-queue), so the probe
//      never attaches to, or later deletes, something it didn't create
//   2. creates the queue; any error other than "already exists" stops the deploy
//   3. deploys the Worker (workers.dev; first use of workers.dev on an account registers a subdomain)
//   4. stores a random PROBE_TOKEN with `wrangler secret put` (encrypted, not a plain var)
//   5. saves { url, token, queueCreatedByProbe } to probe/.probe.json (git-ignored) for check.mjs and destroy.mjs
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fail, queueExists, QUEUE, STATE_FILE, WORKER, wrangler } from "./lib.mjs";

const reuse = process.argv.includes("--reuse-queue");

if (queueExists(QUEUE)) {
  if (!reuse) {
    fail(
      `A queue named "${QUEUE}" already exists in this account. The probe won't attach to a queue it didn't create.\n` +
        `If it is left over from an earlier probe run, delete it (npx wrangler queues delete ${QUEUE}) or rerun with --reuse-queue.`,
    );
  }
  console.log(`Reusing existing queue "${QUEUE}" (--reuse-queue); destroy:probe will leave it in place.`);
}
let queueCreatedByProbe = false;
if (!reuse) {
  const { status, out } = wrangler(["queues", "create", QUEUE]);
  if (status !== 0 && !/already exists/i.test(out)) fail(`Creating queue "${QUEUE}" failed (see above). Nothing was deployed.`);
  queueCreatedByProbe = status === 0;
}

const deploy = wrangler(["deploy", "--config", "probe/wrangler.jsonc"]);
if (deploy.status !== 0) fail("wrangler deploy failed (see above). Run `npm run destroy:probe` to remove the queue.");
const url = deploy.out.match(new RegExp(`https://${WORKER}\\.[\\w.-]+\\.workers\\.dev`))?.[0];

const token = randomBytes(24).toString("base64url");
const secret = wrangler(["secret", "put", "PROBE_TOKEN", "--config", "probe/wrangler.jsonc"], { input: `${token}\n` });
writeFileSync(STATE_FILE, JSON.stringify({ url: url ?? null, token, queueCreatedByProbe }, null, 2));
if (secret.status !== 0) fail("Setting the PROBE_TOKEN secret failed (see above). Every probe route returns 403 until it is set.");
if (!url) {
  fail(
    "Deployed, but no workers.dev URL was found in wrangler's output (is workers.dev disabled for this account?).\n" +
      "Find the URL in the dashboard and run: npm run check:probe -- --url=https://<the probe URL>",
  );
}
console.log(`\nProbe deployed at ${url}. Now run: npm run check:probe`);
