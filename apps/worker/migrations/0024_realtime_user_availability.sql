-- M2a: sources of derived availability (Notifications §5.7, §7).
CREATE TABLE IF NOT EXISTS user_availability (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  away_until TEXT,
  away_time_off_id TEXT,
  focus_until INTEGER,
  focus_event_id TEXT,
  schedule_dnd_until INTEGER,
  updated_at INTEGER NOT NULL
);
