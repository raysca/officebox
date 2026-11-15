-- Per-account, per-IP sign-in throttle (Identity §4.4 and §2 Decisions; Platform §8 "Sign-in attempts,
-- per account", a D1 counter). Keyed by an HMAC of the lower-cased email and the client's IP bucket, so
-- unknown emails are throttled exactly like real accounts (no enumeration) and an attacker only slows
-- their own IP. attempts counts attempts that reached the password check since the last success, within
-- an hour of the previous attempt; a success deletes the row. Rows idle for an hour are pruned hourly.
-- The cross-IP ceiling lives in rate_counters (scope sign_in_account). Excluded from export (Platform §6).
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS sign_in_throttle (
  account_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL         -- UTC ms
);
CREATE INDEX IF NOT EXISTS sign_in_throttle_last ON sign_in_throttle(last_attempt_at);
