import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";

/**
 * Whether first-run setup has completed (`installation.setup_completed_at`, TDD §6.8). Once true it
 * stays true, so a positive answer is cached for the life of the isolate; a negative one is checked
 * again every time (setup may have just completed in another isolate).
 */

const completed = new WeakSet<D1Database>();

export async function isSetupComplete(ctx: Pick<CoreContext, "env">): Promise<boolean> {
  const db = ctx.env.DB;
  if (completed.has(db)) return true;
  const row = expectOk(
    await new Database(db).first<{ done: number }>(
      "SELECT setup_completed_at IS NOT NULL AS done FROM installation WHERE id = 1",
    ),
  );
  if (row?.done) completed.add(db);
  return row?.done === 1;
}

export function markSetupComplete(db: D1Database): void {
  completed.add(db);
}

/** Forgets the cached answer (tests that reset the installation). */
export function clearSetupCache(db: D1Database): void {
  completed.delete(db);
}
