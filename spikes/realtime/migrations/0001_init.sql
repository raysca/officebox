-- Subset of the TDD §2.1 schema needed by the realtime spike.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at INTEGER NOT NULL
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('public', 'private', 'dm')),
  name TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  projected_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_user ON channel_members(user_id);

-- Derived copy of ChatChannel DO state (TDD §3.3)
CREATE TABLE messages (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL UNIQUE,
  sender_id TEXT REFERENCES users(id),
  parent_id TEXT,
  body TEXT,
  reactions TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  last_event_seq INTEGER NOT NULL,
  PRIMARY KEY (channel_id, seq)
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'document' CHECK (type IN ('document', 'whiteboard')),
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  general_access TEXT NOT NULL DEFAULT 'restricted'
    CHECK (general_access IN ('restricted', 'workspace_view', 'workspace_comment', 'workspace_edit')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE resource_grants (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'channel')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_type, resource_id, principal_type, principal_id)
);

CREATE TABLE ws_tickets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
