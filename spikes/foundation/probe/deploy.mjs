// Deploys the production probe to your Cloudflare account. Usage: npm run deploy:probe [-- --reuse-queue]
//
// Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN, plus CLOUDFLARE_ACCOUNT_ID if the login has several
// accounts) first. Steps:
//   1. refuses if a Worker named officebox-foundation-probe already exists, or a queue of that name exists
//      (unless --reuse-queue), so the probe never overwrites, attaches to, or later deletes something it didn't
//      create
//   2. writes probe/.probe.json (mode 0600) with both "created" flags false, BEFORE creating anything
//   3. creates the queue (any error other than "already exists" stops the deploy) and records
//      queueCreatedByProbe right after a successful create
//   4. records workerCreatedByProbe, deploys the Worker to workers.dev, then stores a random PROBE_TOKEN with
//      `wrangler secret put`
// So destroy.mjs always knows what it may delete, even if a later step fails or the script is killed.
import { randomBytes } from "node:crypto";
import { fail, queueExists, QUEUE, readState, WORKER, workerExists, wrangler, writeState } from "./lib.mjs";

const reuse = process.argv.includes("--reuse-queue");

if (readState()) fail("probe/.probe.json already exists: a probe may still be deployed. Run `npm run destroy:probe` first.");
if (workerExists(WORKER)) {
  fail(`A Worker named "${WORKER}" already exists in this account. The probe won't overwrite a Worker it didn't create.`);
}
const queueAlreadyThere = queueExists(QUEUE);
if (reuse && !queueAlreadyThere) fail(`--reuse-queue was given, but there is no queue named "${QUEUE}" to reuse.`);
if (queueAlreadyThere) {
  if (!reuse) {
    fail(
      `A queue named "${QUEUE}" already exists in this account. The probe won't attach to a queue it didn't create.\n` +
        `If it is left over from an earlier probe run, delete it (npx wrangler queues delete ${QUEUE}) or rerun with --reuse-queue.`,
    );
  }
  console.log(`Reusing existing queue "${QUEUE}" (--reuse-queue); destroy:probe will leave it in place.`);
}

const token = randomBytes(24).toString("base64url");
const state = { url: null, token, queueCreatedByProbe: false, workerCreatedByProbe: false };
writeState(state); // before creating anything
if (!reuse) {
  const { status, out } = wrangler(["queues", "create", QUEUE]);
  if (status !== 0 && !/already exists/i.test(out)) fail(`Creating queue "${QUEUE}" failed (see above). Nothing was deployed.`);
  state.queueCreatedByProbe = status === 0;
  writeState(state);
}
// Recorded before the deploy: we checked the Worker didn't exist, so whatever exists under that name after this
// point (even after a failed or partial deploy) was created by the probe.
state.workerCreatedByProbe = true;
writeState(state);

const deploy = wrangler(["deploy", "--config", "probe/wrangler.jsonc"]);
if (deploy.status !== 0) fail("wrangler deploy failed (see above). Run `npm run destroy:probe` to remove what the probe created.");
state.url = deploy.out.match(new RegExp(`https://${WORKER}\\.[\\w.-]+\\.workers\\.dev`))?.[0] ?? null;
writeState(state);

const secret = wrangler(["secret", "put", "PROBE_TOKEN", "--config", "probe/wrangler.jsonc"], { input: `${token}\n` });
if (secret.status !== 0) fail("Setting the PROBE_TOKEN secret failed (see above). Every probe route returns 403 until it is set.");
if (!state.url) {
  fail(
    "Deployed, but no workers.dev URL was found in wrangler's output (is workers.dev enabled for this account?).\n" +
      "Find the URL in the dashboard and run: npm run check:probe -- --url=https://<the probe URL>",
  );
}
console.log(`\nProbe deployed. Now run: npm run check:probe   (then npm run destroy:probe promptly)`);
