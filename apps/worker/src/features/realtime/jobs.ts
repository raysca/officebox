import { defineJob, type CronJob } from "../../core/cron";
import { Database, expectOk } from "../../core/db";

const WS_TICKET_RETENTION_MS = 60 * 60 * 1000;

/**
 * Scheduled jobs for the realtime feature (TDD §7.8).
 *
 * - **realtime.prune** (daily): deletes expired or consumed `ws_tickets` rows older than an hour.
 */
export const REALTIME_JOBS: readonly CronJob[] = [
  defineJob({
    name: "realtime.prune",
    schedule: "daily",
    run: async (ctx) => {
      const db = new Database(ctx.env.DB);
      const cutoff = ctx.now() - WS_TICKET_RETENTION_MS;
      const res = expectOk(
        await db.run("DELETE FROM ws_tickets WHERE expires_at < ?1 OR (used_at IS NOT NULL AND used_at < ?1)", cutoff),
      );
      ctx.log.info("pruned ws_tickets", { deleted: res.changes });
    },
  }),
];
