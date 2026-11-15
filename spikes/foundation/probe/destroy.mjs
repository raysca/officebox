// Removes everything deploy.mjs created. Usage: npm run destroy:probe
//   1. deletes the Worker (wrangler delete --force)
//   2. deletes the queue, if deploy.mjs created it (state in probe/.probe.json)
//   3. removes probe/.probe.json
// Rate Limiting namespaces (910001, 910002) are not separate resources: they exist only as binding config.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { QUEUE, STATE_FILE, wrangler } from "./lib.mjs";

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
let ok = true;

const del = wrangler(["delete", "--config", "probe/wrangler.jsonc", "--force"], { input: "y\n" });
if (del.status !== 0 && !/not found|does not exist|10007/i.test(del.out)) ok = false;

if (state.queueCreatedByProbe === false) {
  console.log(`Leaving queue "${QUEUE}" in place: the probe reused it rather than creating it.`);
} else {
  // queueCreatedByProbe true, or no state file (assume an earlier probe run created it).
  const q = wrangler(["queues", "delete", QUEUE], { input: "y\n" });
  if (q.status !== 0 && !/not found|does not exist|11000/i.test(q.out)) ok = false;
}

if (ok) {
  rmSync(STATE_FILE, { force: true });
  console.log("\nProbe removed (Worker, queue, local state).");
} else {
  console.error("\nSomething could not be deleted (see above). probe/.probe.json is kept; fix and rerun npm run destroy:probe.");
  process.exit(1);
}
