-- magic_link_issues: our record of each magic link, beside better-auth's own verification row
-- (Identity §4.4, §5; TDD §8.1). The confirm POST consumes it with a compare-and-set before better-auth's
-- verify runs, so two concurrent POSTs with one token sign in at most once. Revoking a person's pending
-- links (email change, recovery link; M1c) marks their rows revoked by normalised email.
-- token_hash = HMAC(TOKEN_HASH_KEY, token). user_id is NULL for addresses that get no mail (owners,
-- admins, unknown, disabled, system), so those rows can never be consumed.
-- Excluded from exports (Platform §6). Deleted 7 days after use or expiry (TDD §7.8).
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS magic_link_issues (
  token_hash TEXT PRIMARY KEY,
  email_normalised TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS magic_link_issues_email ON magic_link_issues(email_normalised);
CREATE INDEX IF NOT EXISTS magic_link_issues_expires ON magic_link_issues(expires_at);
