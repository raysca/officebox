import { defineJob, type CronJob } from "../../core/cron";
import { pruneSessions } from "./sessions";
import { pruneSignInThrottle } from "./sign-in";

/** Identity's daily housekeeping (TDD §7.8). Both jobs are idempotent deletes. */
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
    schedule: "daily",
    run: async (ctx) => {
      ctx.log.info("pruned sign-in throttle rows", { deleted: await pruneSignInThrottle(ctx) });
    },
  }),
];
