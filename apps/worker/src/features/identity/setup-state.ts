import { auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";

/**
 * Setup state (TDD §6.8): whether setup is complete, and completing it.
 *
 * Setup is **complete only once the owner has a passkey**. Completion is a compare-and-set on the
 * claim nonce (`… WHERE setup_claim = :nonce AND setup_completed_at IS NULL`), so a late registration
 * can't complete a claim that expired and was claimed again. It runs from the passkey registration's
 * after hook and, if that failed, from the hourly repair job.
 */

const completed = new WeakSet<D1Database>();

/** Positive answers are cached for the life of the isolate: once complete, setup stays complete. */
export async function isSetupComplete(ctx: Pick<CoreContext, "env">): Promise<boolean> {
  const db = ctx.env.DB;
  if (completed.has(db)) return true;
  const row = expectOk(
    await new Database(db).first<{ done: number }>(
      "SELECT setup_completed_at IS NOT NULL AS done FROM installation WHERE id = 1",
    ),
  );
  if (row?.done === 1) completed.add(db);
  return row?.done === 1;
}

/** Forgets the cached answer (tests that reset the installation). */
export function clearSetupCache(db: D1Database): void {
  completed.delete(db);
}

/**
 * Completes setup for `claim` if it is still the current claim and its owner has a passkey. Returns
 * whether this call completed it. Clears the generated setup token (TDD §6.8) and audits.
 */
export async function completeSetupClaim(ctx: CoreContext, claim: string, ownerId: string): Promise<boolean> {
  const db = new Database(ctx.env.DB);
  const now = ctx.now();
  const result = expectOk(
    await db.batchRun([
      db.statement(
        `UPDATE installation
            SET setup_completed_at = ?, setup_token_hash = NULL, setup_token_expires_at = NULL
          WHERE id = 1 AND setup_claim = ? AND setup_completed_at IS NULL
            AND EXISTS (SELECT 1 FROM passkeys p JOIN users u ON u.id = p.user_id
                         WHERE u.id = ? AND u.created_attempt_id = ? AND u.role = 'owner')`,
        now,
        claim,
        ownerId,
        claim,
      ),
      await auditStatement(
        ctx,
        { action: "setup.complete", actor: ownerId, target: { type: "user", id: ownerId } },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  const done = (result[0]?.changes ?? 0) === 1;
  if (done) {
    completed.add(ctx.env.DB);
    ctx.log.info("first-run setup complete", { ownerId });
  }
  return done;
}
