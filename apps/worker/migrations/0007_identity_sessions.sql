-- Sessions (TDD §2.1, §8.1; Identity §4.5, §5): one row per signed-in device. The refresh token is
-- stored only as an HMAC (TOKEN_HASH_KEY). previous_refresh_hash and rotated_at give two tabs that
-- refresh at once the same successor for 30 seconds. The daily identity.prune_sessions job deletes
-- rows once expired or revoked, taking the device label and location with them.
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  session_epoch INTEGER NOT NULL,          -- must equal users.session_epoch to stay valid
  previous_refresh_hash TEXT,              -- the token just rotated away (30-second grace window)
  retired_refresh_hashes TEXT,             -- JSON array: hashes of the last 5 tokens rotated away (reuse detection)
  rotated_at INTEGER,
  user_agent TEXT,
  device_label TEXT,                       -- e.g. "Chrome on macOS"
  approx_location TEXT,                    -- city and country from request.cf, if available
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,             -- last use + 30 days (sliding)
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
