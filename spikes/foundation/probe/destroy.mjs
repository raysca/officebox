// Removes what deploy.mjs created, and only that. Usage: npm run destroy:probe
//   1. detaches the probe Worker from the probe queue as its consumer (Cloudflare refuses to delete a
//      Worker that consumes a queue, or a queue a Worker is bound to: errors 10064 and 11005)
//   2. deletes the Worker, if probe/.probe.json says the probe created it
//   3. deletes the queue, if probe/.probe.json says the probe created it
//   4. removes probe/.probe.json
// With no state file it touches nothing: it can't know what the probe created.
// Rate Limiting namespaces (910001, 910002) are not separate resources: they exist only as binding config.
import { rmSync } from "node:fs";
import { queueExists, QUEUE, readState, STATE_FILE, WORKER, wrangler } from "./lib.mjs";

const state = readState();
if (!state) {
  console.log(
    `No probe state (probe/.probe.json), so nothing was deleted.\n` +
      `If you created the probe from this clone and lost the state, delete it manually:\n` +
      `  npx wrangler queues consumer remove ${QUEUE} ${WORKER}\n  npx wrangler delete --name ${WORKER}\n  npx wrangler queues delete ${QUEUE}`,
  );
  process.exit(0);
}

if (state.workerCreatedByProbe !== true && state.queueCreatedByProbe !== true) {
  rmSync(STATE_FILE, { force: true });
  console.log("Nothing is recorded as created by the probe, so nothing was deleted. Removed probe/.probe.json.");
  process.exit(0);
}

let ok = true;
// Detach the consumer first; both resources are the probe's own when either is recorded as created
// (deploy refuses to attach to a pre-existing Worker or queue without --reuse-queue). Not attached or
// already gone counts as done.
if (queueExists(QUEUE)) {
  const c = wrangler(["queues", "consumer", "remove", QUEUE, WORKER], { input: "y\n" });
  if (c.status !== 0 && !/not.*(found|exist|consumer)|no consumer/i.test(c.out)) {
    console.error(`Couldn't detach "${WORKER}" from queue "${QUEUE}"; trying the deletes anyway.`);
  }
}
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
