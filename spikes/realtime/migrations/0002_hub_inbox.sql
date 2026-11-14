-- UserHub / presence / inbox additions (TDD §2.1, §3.5).
ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN mentions TEXT;

-- inbox_items is also the store for in-app notifications
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('notification', 'action', 'schedule', 'follow')),
  event_type TEXT NOT NULL,            -- mention, dm
  source_type TEXT NOT NULL,           -- channel
  source_id TEXT NOT NULL,
  source_seq INTEGER,                  -- channel seq of the message, used for read-through resolution
  message_id TEXT,
  actor_id TEXT REFERENCES users(id),
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unread' CHECK (state IN ('unread', 'read', 'snoozed', 'done', 'dismissed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX inbox_items_user_state ON inbox_items(user_id, state, created_at);
CREATE INDEX inbox_items_source ON inbox_items(source_type, source_id);
