-- The cross-IP sign-in layer (Identity §2 Decisions, §4.4; Platform §8), both tables keyed by HMACs, so
-- they hold no email or IP address and unknown emails behave exactly like real accounts.
--
-- sign_in_failure_buckets: the distinct client IP buckets (IPv4 address or IPv6 /64) that tried an
-- account and failed in a clock hour, or used their one clean-lane attempt in slow mode. 10 distinct
-- buckets in an hour put the account in slow mode (re-armed each hour). One IP adds at most one row,
-- so a single address can never trip it; in slow mode, inserting the row is the clean-lane claim.
--
-- sign_in_slots: in slow mode, browsers without a valid known-device cookie whose bucket has already
-- tried share one sign-in slot per account every 30 seconds, reserved atomically with a guarded upsert
-- on next_allowed_at.
--
-- Both are pruned hourly and excluded from export (Platform §6). Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS sign_in_failure_buckets (
  account_key TEXT NOT NULL,     -- HMAC(TOKEN_HASH_KEY, lower-cased email)
  window_start INTEGER NOT NULL, -- UTC ms, start of the hour
  bucket_key TEXT NOT NULL,      -- HMAC(TOKEN_HASH_KEY, IP bucket)
  PRIMARY KEY (account_key, window_start, bucket_key)
);
CREATE INDEX IF NOT EXISTS sign_in_failure_buckets_window ON sign_in_failure_buckets(window_start);

CREATE TABLE IF NOT EXISTS sign_in_slots (
  account_key TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL -- UTC ms
);
CREATE INDEX IF NOT EXISTS sign_in_slots_next ON sign_in_slots(next_allowed_at);
