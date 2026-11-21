-- Handle changes: a log of who changed their @handle when (Identity §4.8, Platform §8; M1d). The limit of
-- 3 changes per 30 days counts these rows. The released `handles` rows can't serve as that history,
-- because taking a held handle back deletes its row. No handle values are stored, only the member and
-- the time; rows go with the user row. One logical change; safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS handle_changes (
  id TEXT PRIMARY KEY,                     -- ULID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  changed_at INTEGER NOT NULL              -- epoch ms
);
CREATE INDEX IF NOT EXISTS handle_changes_user ON handle_changes(user_id, changed_at);
