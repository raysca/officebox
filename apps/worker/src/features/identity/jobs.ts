import { defineJob, type CronJob } from "../../core/cron";
import { Database, expectOk } from "../../core/db";
import { pruneCounterEventsStatement } from "./counters";
import { repairInvitations } from "./invitations";
import { DEVICE_RETENTION_MS } from "./known-devices";
import { expireStaleClaim, repairSetup } from "./setup";

const INVITATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Identity's scheduled jobs (TDD §7.8). All idempotent.
 *
 * - **identity.repair** (hourly): the setup half of the repair job (TDD §6.8): completes setup when the
 *   claimed owner has a passkey but completion didn't run, and releases a claim that expired 24 hours
 *   after it was made, in one conditional batch. The invitation half rolls partial accepts forward or
 *   releases them, never resurrecting a consumed invitation (`repairInvitations`, M1b).
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
      await repairInvitations(ctx);
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
          pruneCounterEventsStatement(db, now),
          // TDD §7.8: magic_link_issues 7 days after use or expiry; user_devices unused for 400 days.
          db.statement(
            "DELETE FROM magic_link_issues WHERE expires_at < ?1 OR consumed_at < ?1 OR revoked_at < ?1",
            now - 7 * day,
          ),
          db.statement("DELETE FROM user_devices WHERE last_seen_at < ?", now - DEVICE_RETENTION_MS),
          // Revoked invitations, and expired ones never consumed, 30 days on (default).
          db.statement(
            `DELETE FROM invitations
              WHERE (revoked_at IS NOT NULL AND revoked_at < ?1)
                 OR (accepted_attempt_id IS NULL AND accepted_at IS NULL AND expires_at < ?1)`,
            now - INVITATION_RETENTION_MS,
          ),
          // Email delivery records: 30 days (default).
          db.statement("DELETE FROM email_deliveries WHERE created_at < ?", now - EMAIL_DELIVERY_RETENTION_MS),
        ]),
      );
      ctx.log.info("pruned identity rows", {
        sessions: result[0]?.changes ?? 0,
        verifications: result[1]?.changes ?? 0,
        tickets: result[2]?.changes ?? 0,
        magicLinks: result[4]?.changes ?? 0,
        devices: result[5]?.changes ?? 0,
        invitations: result[6]?.changes ?? 0,
        emailDeliveries: result[7]?.changes ?? 0,
      });
    },
  }),
];
