-- passkey_counter_events: each accepted passkey assertion's counter move (previous -> new), kept for a
-- day (Identity §4.4 clone detection). It tells a real clone from a race: when better-auth refuses an
-- assertion for its counter, the counter as it was when that assertion's challenge was issued is the
-- `previous_count` of the first move after the challenge (or the stored value if nothing moved). Only an
-- assertion at or below that is a clone; one above it lost a race with a newer sign-in and is refused
-- quietly. Pruned on write and daily. Excluded from export (operational). Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS passkey_counter_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passkey_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
  previous_count INTEGER NOT NULL,
  new_count INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS passkey_counter_events_passkey ON passkey_counter_events(passkey_id, at);
