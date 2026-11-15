import {
  securityNoticeSchema,
  type SecurityNotice,
  type SecurityNoticeDetails,
  type SecurityNoticeKind,
} from "@officebox/shared";
import { z } from "zod";
import { Database, expectOk } from "../../core/db";
import { ulid } from "../../core/ids";

/**
 * The security-notice banner list (Identity §4.6a): `users.pending_security_notice`, a JSON list.
 *
 * Every notice is appended here and shown as a banner after sign-in until it's acknowledged on a fresh
 * passkey sign-in (`security_notice.ack`, a step-up action in the permission engine), so someone
 * holding a stolen session can't hide it. **Interim (M1a):** banner only; email delivery starts in
 * M1b and the inbox record in M2.
 *
 * Appends are one statement (`json_insert(…, '$[#]', …)`), so concurrent notices never overwrite each
 * other.
 */

/** At most this many pending notices are kept; the oldest are dropped first (default). */
export const MAX_PENDING_NOTICES = 50;

export function noticeStatement(
  database: Database,
  userId: string,
  kind: SecurityNoticeKind,
  details: SecurityNoticeDetails,
  now: number,
): D1PreparedStatement {
  const notice: SecurityNotice = { id: ulid(), kind, at: now, details };
  return database.statement(
    `UPDATE users
        SET pending_security_notice = json_insert(
          CASE WHEN json_array_length(coalesce(pending_security_notice, '[]')) >= ${MAX_PENDING_NOTICES}
               THEN json_remove(pending_security_notice, '$[0]')
               ELSE coalesce(pending_security_notice, '[]') END,
          '$[#]', json(?))
      WHERE id = ?`,
    JSON.stringify(notice),
    userId,
  );
}

/** Appends one notice to a person's banner list. */
export async function appendNotice(
  db: D1Database,
  userId: string,
  kind: SecurityNoticeKind,
  details: SecurityNoticeDetails,
  now: number,
): Promise<void> {
  const database = new Database(db);
  expectOk(await database.batchRun([noticeStatement(database, userId, kind, details, now)]));
}

const listSchema = z.array(z.unknown());

/** Parses a stored list; entries that don't match the schema (a future kind) are skipped. */
export function parseNotices(raw: string | null): SecurityNotice[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = listSchema.safeParse(value);
  if (!list.success) return [];
  const out: SecurityNotice[] = [];
  for (const entry of list.data) {
    const parsed = securityNoticeSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.at - b.at);
}

export async function listNotices(db: D1Database, userId: string): Promise<SecurityNotice[]> {
  const row = expectOk(
    await new Database(db).first<{ pending_security_notice: string | null }>(
      "SELECT pending_security_notice FROM users WHERE id = ?",
      userId,
    ),
  );
  return parseNotices(row?.pending_security_notice ?? null);
}

/**
 * Removes acknowledged notices (all of them when `ids` is omitted) in one statement, so a notice
 * appended concurrently is never lost. Returns how many were removed.
 */
export async function acknowledgeNotices(db: D1Database, userId: string, ids?: readonly string[]): Promise<number> {
  const before = await listNotices(db, userId);
  const keep = ids === undefined ? "0" : `json_extract(value, '$.id') NOT IN (SELECT value FROM json_each(?))`;
  const params = ids === undefined ? [userId] : [JSON.stringify(ids), userId];
  expectOk(
    await new Database(db).run(
      `UPDATE users
          SET pending_security_notice = (
            SELECT CASE WHEN count(*) = 0 THEN NULL ELSE json_group_array(json(value)) END
              FROM json_each(coalesce(pending_security_notice, '[]')) WHERE ${keep}
          )
        WHERE id = ?`,
      ...params,
    ),
  );
  const after = await listNotices(db, userId);
  return Math.max(0, before.length - after.length);
}
