-- Per-account sign-in throttle (Identity §4.4; Platform §8 "Sign-in attempts, per account", a D1
-- counter). Keyed by an HMAC of the lower-cased email, so unknown emails are throttled exactly like
-- real accounts and the throttle can't reveal which emails exist. attempts counts attempts since the
-- last successful sign-in, within an hour of the previous attempt; a success deletes the row. Rows
-- idle for an hour are pruned daily. Excluded from export (Platform §6), like rate_counters.
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS sign_in_throttle (
  account_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL         -- UTC ms
);
CREATE INDEX IF NOT EXISTS sign_in_throttle_last ON sign_in_throttle(last_attempt_at);
