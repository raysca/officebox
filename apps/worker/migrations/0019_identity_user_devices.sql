-- user_devices: browsers a member has signed in from, for the "magic-link sign-in from a new device"
-- security notice (Identity §4.4, §5; default). The device cookie (__Host-, HttpOnly, Secure, Path=/)
-- holds a random ID, set on every successful sign-in by passkey or magic link; only its
-- HMAC(TOKEN_HASH_KEY, value) is stored. Rows unused for 400 days are deleted (TDD §7.8).
-- Excluded from exports (Platform §6). Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS user_devices (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_hash)
);
CREATE INDEX IF NOT EXISTS user_devices_last_seen ON user_devices(last_seen_at);
