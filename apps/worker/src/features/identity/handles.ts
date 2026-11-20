import {
  apiError,
  err,
  HANDLE_CHANGE_WINDOW_MS,
  HANDLE_CHANGES_PER_WINDOW,
  HANDLE_HOLD_MS,
  handleShapeProblem,
  ok,
  type ApiError,
  type HandleAvailability,
  type HandleUnavailableReason,
  type Result,
} from "@officebox/shared";
import { Database, expectOk } from "../../core/db";

/**
 * @handles (Identity §4.8; M1d). The `handles` table is authoritative; `users.handle` is a copy written
 * in the same D1 batch as the `handles` row (Identity §5).
 *
 * - **One namespace** for people, groups and reserved names: `handles.handle` is the primary key, stored
 *   lower-cased, so uniqueness ignores case and a collision between two claims is a constraint failure.
 * - **Reserved:** the static words (shared `RESERVED_HANDLES`) by shape, and the assistant's derived
 *   handle as an `owner_type = 'reserved'` row (migration 0029).
 * - **Released handles are held for 30 days:** a change keeps the old row with `released_at` set (and
 *   its owner), so nobody else can claim it until the hold passes; the same person may take it back at
 *   once **(default)**. An expired hold is deleted in the batch that claims the handle.
 * - **History:** those released rows are also the handle history Platform §8 counts: at most
 *   {@link HANDLE_CHANGES_PER_WINDOW} changes per {@link HANDLE_CHANGE_WINDOW_MS}.
 */

interface HandleRow {
  owner_type: string;
  owner_id: string | null;
  released_at: number | null;
}

async function handleRow(db: Database, handle: string): Promise<HandleRow | null> {
  return expectOk(
    await db.first<HandleRow>("SELECT owner_type, owner_id, released_at FROM handles WHERE handle = ?", handle),
  );
}

/** Whether a held (released) handle's 30 days have passed. */
const holdExpired = (releasedAt: number, now: number) => releasedAt <= now - HANDLE_HOLD_MS;

/**
 * Whether `handle` (already normalised) can be claimed by `userId` (or by a new account when null), and
 * why not. Shape and reserved words first, then the table.
 */
export async function handleAvailability(
  d1: D1Database,
  handle: string,
  userId: string | null,
  now: number,
): Promise<HandleAvailability> {
  const shape = handleShapeProblem(handle);
  if (shape) return { handle, available: false, yours: false, reason: shape };
  const row = await handleRow(new Database(d1), handle);
  if (!row) return { handle, available: true, yours: false };
  const mine = userId !== null && row.owner_type === "user" && row.owner_id === userId;
  if (mine) return { handle, available: true, yours: row.released_at === null };
  if (row.owner_type === "reserved") return { handle, available: false, yours: false, reason: "reserved" };
  if (row.released_at !== null) {
    return holdExpired(row.released_at, now)
      ? { handle, available: true, yours: false }
      : { handle, available: false, yours: false, reason: "held" };
  }
  return { handle, available: false, yours: false, reason: "taken" };
}

/**
 * The statement that frees `handle` for a claim in the same batch: deletes its row only when it's a
 * released handle whose hold has passed (or, with `userId`, one that person released themselves).
 */
export function freeHeldHandleStatement(db: Database, handle: string, now: number, userId: string | null = null) {
  return db.statement(
    `DELETE FROM handles WHERE handle = ?1 AND released_at IS NOT NULL
        AND (released_at <= ?2 OR (owner_type = 'user' AND owner_id = ?3))`,
    handle,
    now - HANDLE_HOLD_MS,
    userId,
  );
}

const MESSAGES: Record<HandleUnavailableReason, string> = {
  invalid: "2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.",
  reserved: "That handle is reserved.",
  taken: "That handle is taken. Pick another.",
  held: "That handle was released recently and is held for 30 days. Pick another.",
};

/** The typed error for an unusable handle, with the field message the forms show. */
export function handleError(reason: HandleUnavailableReason): ApiError {
  const message = MESSAGES[reason];
  if (reason === "invalid" || reason === "reserved") {
    return apiError("validation_failed", message, { reason: `handle_${reason}`, fields: { handle: [message] } });
  }
  return apiError("conflict", message, { reason: `handle_${reason}`, fields: { handle: [message] } });
}

/** Handle changes left in the current 30-day window, and when the oldest counted change drops out. */
export async function handleChangeAllowance(
  d1: D1Database,
  userId: string,
  now: number,
): Promise<{ left: number; nextAt: number | null }> {
  const rows = expectOk(
    await new Database(d1).all<{ released_at: number }>(
      `SELECT released_at FROM handles
        WHERE owner_type = 'user' AND owner_id = ? AND released_at IS NOT NULL AND released_at > ?
        ORDER BY released_at`,
      userId,
      now - HANDLE_CHANGE_WINDOW_MS,
    ),
  );
  const left = Math.max(0, HANDLE_CHANGES_PER_WINDOW - rows.length);
  const oldest = rows[0]?.released_at;
  return { left, nextAt: left === 0 && oldest !== undefined ? oldest + HANDLE_CHANGE_WINDOW_MS : null };
}

export type HandleChange = { changed: false } | { changed: true; from: string | null; to: string };

/**
 * Changes an active member's handle (Identity §4.8). One D1 batch: free an expired hold, claim the new
 * handle, release the old one (held 30 days) and copy it to `users.handle`. Every write is conditional on
 * the member's handle still being the one read, so two concurrent changes by the same person can't both
 * apply; a collision with someone else's claim is the primary key's constraint failure.
 */
export async function changeHandle(
  d1: D1Database,
  userId: string,
  handle: string,
  now: number,
): Promise<Result<HandleChange, ApiError>> {
  const db = new Database(d1);
  const user = expectOk(
    await db.first<{ handle: string | null }>("SELECT handle FROM users WHERE id = ? AND status = 'active'", userId),
  );
  if (!user) return err(apiError("unauthenticated", "Sign in to continue."));
  const current = user.handle;
  if (current === handle) return ok({ changed: false });

  const availability = await handleAvailability(d1, handle, userId, now);
  if (!availability.available) return err(handleError(availability.reason ?? "taken"));

  const allowance = await handleChangeAllowance(d1, userId, now);
  if (allowance.left === 0) {
    return err(
      apiError("rate_limited", "You can change your handle 3 times in 30 days.", {
        reason: "handle_change_limit",
        retryAfterSeconds: Math.max(1, Math.ceil(((allowance.nextAt ?? now) - now) / 1000)),
      }),
    );
  }

  const stillCurrent = "EXISTS (SELECT 1 FROM users WHERE id = ?2 AND handle IS ?3 AND status = 'active')";
  const claimed =
    "EXISTS (SELECT 1 FROM handles WHERE handle = ?1 AND owner_type = 'user' AND owner_id = ?2 AND released_at IS NULL)";
  const result = await db.batchRun([
    freeHeldHandleStatement(db, handle, now, userId),
    db.statement(
      `INSERT INTO handles (handle, owner_type, owner_id) SELECT ?1, 'user', ?2 WHERE ${stillCurrent}`,
      handle,
      userId,
      current,
    ),
    db.statement(
      `UPDATE handles SET released_at = ?4
        WHERE handle = ?3 AND owner_type = 'user' AND owner_id = ?2 AND released_at IS NULL AND ${claimed}`,
      handle,
      userId,
      current,
      now,
    ),
    db.statement(
      `UPDATE users SET handle = ?1, updated_at = ?4 WHERE id = ?2 AND handle IS ?3 AND status = 'active' AND ${claimed}`,
      handle,
      userId,
      current,
      now,
    ),
  ]);
  if (!result.ok) {
    // Someone claimed it between the check and the batch (the primary key decided): nothing was written.
    if (result.error.kind === "unique") return err(handleError("taken"));
    throw new Error(`handle change: unexpected ${result.error.kind} constraint failure`);
  }
  if ((result.value[3]?.changes ?? 0) !== 1) {
    return err(apiError("conflict", "Your handle changed at the same time. Try again.", { reason: "handle_changed" }));
  }
  return ok({ changed: true, from: current, to: handle });
}
