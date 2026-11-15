import { Database, expectOk } from "../../core/db";

/**
 * Passkey signature counters: telling a clone from a race (Identity §4.4, §9).
 *
 * SimpleWebAuthn refuses any assertion whose counter is at or below the **stored** one. Two legitimate
 * sign-ins with the same passkey can arrive out of order: A signs n+1 and B signs n+2, B is verified
 * first and stores n+2, and A is refused even though nobody copied anything. The refusal alone can't
 * tell the two apart, so each accepted assertion records its move (`passkey_counter_events`), and a
 * refused assertion is judged against the counter **as it was when its own challenge was issued**:
 *
 * - presented ≤ counter at challenge time (and not both 0): a clone, `clone_detected`, with notices;
 * - above that but ≤ the current stored value: a race, refused quietly as an ordinary failure.
 *
 * better-auth stores the new counter with a plain UPDATE (not compare-and-set), so two verifies that
 * both read n can leave n+1 stored after n+2. {@link settleCounter} then raises it back to the highest
 * recorded value. A lost update can only lower the stored counter, which makes the check more lenient,
 * never stricter, so the race rule above still holds.
 */

/** Counter moves are kept this long; a passkey challenge lives 5 minutes. */
export const COUNTER_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Records an accepted assertion's counter move (called before better-auth stores the new value). */
export async function recordCounterMove(
  db: D1Database,
  passkeyId: string,
  previous: number,
  next: number,
  now: number,
): Promise<void> {
  const database = new Database(db);
  expectOk(
    await database.batchRun([
      database.statement(
        "INSERT INTO passkey_counter_events (passkey_id, previous_count, new_count, at) VALUES (?, ?, ?, ?)",
        passkeyId,
        previous,
        next,
        now,
      ),
      database.statement(
        "DELETE FROM passkey_counter_events WHERE passkey_id = ? AND at < ?",
        passkeyId,
        now - COUNTER_EVENT_RETENTION_MS,
      ),
    ]),
  );
}

/** The counter as it was when a challenge issued at `issuedAt` went out. */
export async function counterAtChallenge(
  db: D1Database,
  passkeyId: string,
  issuedAt: number,
  current: number,
): Promise<number> {
  const first = expectOk(
    await new Database(db).first<{ previous_count: number }>(
      `SELECT previous_count FROM passkey_counter_events WHERE passkey_id = ? AND at >= ?
        ORDER BY at, id LIMIT 1`,
      passkeyId,
      issuedAt,
    ),
  );
  return first ? Math.min(first.previous_count, current) : current;
}

/**
 * After an accepted assertion: keep the stored counter monotonic (the highest recorded value wins over
 * a lost plain UPDATE) and record the last use.
 */
export async function settleCounter(db: D1Database, credentialId: string, now: number): Promise<void> {
  expectOk(
    await new Database(db).run(
      `UPDATE passkeys
          SET sign_count = max(sign_count, coalesce((SELECT max(new_count) FROM passkey_counter_events e
                                                      WHERE e.passkey_id = passkeys.id), 0)),
              last_used_at = ?
        WHERE credential_id = ?`,
      now,
      credentialId,
    ),
  );
}

/** The daily prune (identity.prune). */
export function pruneCounterEventsStatement(database: Database, now: number): D1PreparedStatement {
  return database.statement("DELETE FROM passkey_counter_events WHERE at < ?", now - COUNTER_EVENT_RETENTION_MS);
}
