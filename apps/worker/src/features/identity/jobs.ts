import { defineJob, type CronJob } from "../../core/cron";
import { Database, expectOk } from "../../core/db";
import { expireStaleClaim, repairSetup } from "./setup";

/**
 * Identity's scheduled jobs (TDD §7.8). All idempotent.
 *
 * - **identity.repair** (hourly): the setup half of the repair job (TDD §6.8): completes setup when the
 *   claimed owner has a passkey but completion didn't run, and releases a claim that expired 24 hours
 *   after it was made, in one conditional batch. The invitation half arrives in M1b.
 * - **identity.prune** (daily): deletes expired sessions (better-auth deletes them lazily, only when the
 *   cookie is presented again), expired WebAuthn challenges and spent or expired enrolment tickets.
 *   Expired sessions are deleted by SQL here: their sockets were already closed by the UserHub's
 *   recheck (from M2), which closes sockets of sessions whose `expires_at` has passed.
 */
export const IDENTITY_JOBS: readonly CronJob[] = [
  defineJob({
    name: "identity.repair",
    schedule: "hourly",
    run: async (ctx) => {
      const completed = await repairSetup(ctx);
      const released = await expireStaleClaim(ctx);
      if (completed || released) ctx.log.info("identity repair", { completed, released });
    },
  }),
  defineJob({
    name: "identity.prune",
    schedule: "daily",
    run: async (ctx) => {
      const db = new Database(ctx.env.DB);
      const now = ctx.now();
      const day = 24 * 60 * 60 * 1000;
      const result = expectOk(
        await db.batchRun([
          db.statement("DELETE FROM sessions WHERE expires_at < ?", now),
          db.statement("DELETE FROM auth_verifications WHERE expires_at < ?", now),
          db.statement("DELETE FROM auth_tokens WHERE kind = 'passkey_enrol' AND expires_at < ?", now - day),
        ]),
      );
      ctx.log.info("pruned identity rows", {
        sessions: result[0]?.changes ?? 0,
        verifications: result[1]?.changes ?? 0,
        tickets: result[2]?.changes ?? 0,
      });
    },
  }),
];
