// Removes what deploy.mjs created, and only that. Usage: npm run destroy:probe
//   1. deletes the Worker, if probe/.probe.json says the probe created it
//   2. deletes the queue, if probe/.probe.json says the probe created it
//   3. removes probe/.probe.json
// With no state file it touches nothing: it can't know what the probe created.
// Rate Limiting namespaces (910001, 910002) are not separate resources: they exist only as binding config.
import { rmSync } from "node:fs";
import { queueExists, QUEUE, readState, STATE_FILE, WORKER, wrangler } from "./lib.mjs";

const state = readState();
if (!state) {
  console.log(
    `No probe state (probe/.probe.json), so nothing was deleted.\n` +
      `If you created the probe from this clone and lost the state, delete it manually:\n` +
      `  npx wrangler delete --name ${WORKER}\n  npx wrangler queues delete ${QUEUE}`,
  );
  process.exit(0);
}

if (state.workerCreatedByProbe !== true && state.queueCreatedByProbe !== true) {
  rmSync(STATE_FILE, { force: true });
  console.log("Nothing is recorded as created by the probe, so nothing was deleted. Removed probe/.probe.json.");
  process.exit(0);
}

let ok = true;
if (state.workerCreatedByProbe === true) {
  const del = wrangler(["delete", "--config", "probe/wrangler.jsonc", "--force"], { input: "y\n" });
  // Already gone (Cloudflare error 10007) counts as done; anything else is a failure.
  if (del.status !== 0 && !/\b10007\b|This Worker does not exist/.test(del.out)) ok = false;
} else {
  console.log(`Leaving Worker "${WORKER}" in place: the probe didn't create it.`);
}
if (state.queueCreatedByProbe === true) {
  // `queues delete` resolves the name through a filtered list; confirm the exact name exists first.
  if (!queueExists(QUEUE)) {
    console.log(`Queue "${QUEUE}" no longer exists; skipping.`);
  } else {
    const q = wrangler(["queues", "delete", QUEUE], { input: "y\n" });
    if (q.status !== 0) ok = false;
  }
} else {
  console.log(`Leaving queue "${QUEUE}" in place: the probe didn't create it.`);
}

if (ok) {
  rmSync(STATE_FILE, { force: true });
  console.log("\nProbe removed (what it created, plus local state).");
} else {
  console.error("\nSomething could not be deleted (see above). probe/.probe.json is kept; fix and rerun npm run destroy:probe.");
  process.exit(1);
}
