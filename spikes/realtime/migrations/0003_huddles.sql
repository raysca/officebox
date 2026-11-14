-- Huddles: metadata only, never media (TDD §3.6).
CREATE TABLE huddles (
  id TEXT PRIMARY KEY,
  context_type TEXT NOT NULL CHECK (context_type IN ('channel', 'document')),
  context_id TEXT NOT NULL,
  started_by TEXT REFERENCES users(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  peak_participants INTEGER NOT NULL DEFAULT 0,
  had_screen_share INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX huddles_context ON huddles(context_type, context_id, started_at);
-- At most one active huddle per context
CREATE UNIQUE INDEX huddles_active ON huddles(context_type, context_id) WHERE ended_at IS NULL;

CREATE TABLE huddle_participants (
  huddle_id TEXT NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (huddle_id, user_id, joined_at)
);

-- Author of system events posted into channels (huddle started/ended).
INSERT OR IGNORE INTO users (id, email, display_name, role, created_at) VALUES ('system', NULL, 'Officebox', 'member', 0);

-- Installation settings (spike subset of installation.settings): screen_share policy and resolution cap.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('screen_share', 'everyone'), ('screen_share_max_height', '1080');
