import { sent, type EmailDriver, type OutgoingEmail } from "./types";

/**
 * The **test email sink** for local end-to-end runs (PLAN M1 exit criteria: "email through a test
 * email sink"). With `EMAIL_TEST_SINK=1` **and** a canonical origin on `localhost` or `127.0.0.1`, every
 * configured driver is replaced by this one, which records each message in a local D1 table that the
 * Playwright tests read with `wrangler d1 execute --local`. Nothing is sent.
 *
 * The table is created here, on first use, rather than by a migration, so it never exists in a real
 * deployment. A deployed Worker can't have a loopback canonical origin, so setting the variable by
 * mistake in production does nothing (the configured driver sends as usual, and a warning is logged).
 */

export const SINK_TABLE = "email_test_sink";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function sinkAllowed(flag: string | undefined, canonicalOrigin: string | null): boolean {
  if (flag !== "1" || !canonicalOrigin) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(canonicalOrigin).hostname);
  } catch {
    return false;
  }
}

export function sinkDriver(db: D1Database, now: () => number = Date.now): EmailDriver {
  return {
    kind: "sink",
    async send(email: OutgoingEmail) {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS ${SINK_TABLE} (
             id TEXT PRIMARY KEY, recipient TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL,
             text TEXT NOT NULL, html TEXT NOT NULL, created_at INTEGER NOT NULL)`,
        )
        .run();
      await db
        .prepare(
          `INSERT OR IGNORE INTO ${SINK_TABLE} (id, recipient, sender, subject, text, html, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(email.id, email.to, email.from.email, email.subject, email.text, email.html, now())
        .run();
      return sent(`sink-${email.id}`);
    },
  };
}
