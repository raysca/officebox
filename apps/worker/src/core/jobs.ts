import { defineJob, type CronJob } from "./cron";
import { pruneRateCounters } from "./rate-limit";

/**
 * Core cron jobs. Features add their jobs to `JOBS` in `src/index.ts` (TDD §7.8 lists them by
 * schedule). The `core.heartbeat_*` jobs do nothing but prove each trigger reaches the dispatcher.
 */
export const CORE_JOBS: readonly CronJob[] = [
  defineJob({ name: "core.heartbeat_five_minutes", schedule: "five_minutes", run: () => Promise.resolve() }),
  defineJob({ name: "core.heartbeat_hourly", schedule: "hourly", run: () => Promise.resolve() }),
  defineJob({ name: "core.heartbeat_daily", schedule: "daily", run: () => Promise.resolve() }),
  defineJob({
    name: "core.prune_rate_counters",
    schedule: "daily",
    run: async (ctx) => {
      const deleted = await pruneRateCounters(ctx);
      ctx.log.info("pruned rate counters", { deleted });
    },
  }),
];
