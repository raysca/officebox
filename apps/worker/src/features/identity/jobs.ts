import { defineJob, type CronJob } from "../../core/cron";
import { pruneSessions } from "./sessions";
import { pruneSignInThrottle } from "./sign-in";

/** Identity's housekeeping (TDD §7.8). Both jobs are idempotent deletes. */
export const IDENTITY_JOBS: readonly CronJob[] = [
  defineJob({
    name: "identity.prune_sessions",
    schedule: "daily",
    run: async (ctx) => {
      ctx.log.info("pruned sessions", { deleted: await pruneSessions(ctx) });
    },
  }),
  defineJob({
    name: "identity.prune_sign_in_throttle",
    // Hourly, so rows left by attempts on unknown emails don't pile up (they're bounded by the per-IP
    // binding limit and live at most about two hours).
    schedule: "hourly",
    run: async (ctx) => {
      ctx.log.info("pruned sign-in throttle rows", { deleted: await pruneSignInThrottle(ctx) });
    },
  }),
];
