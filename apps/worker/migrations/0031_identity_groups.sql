-- Groups and their members (Identity §4.9, §5; Permissions §3.2, §4.6, §9; M1e). The TDD §2.1 core
-- tables with the Identity §5 columns folded into the baseline (Platform §14), so no later slice
-- rebuilds them:
--
-- - groups.handle is a copy of the authoritative `handles` row (owner_type 'group'), written in the
--   same D1 batch as that row (Identity §5).
-- - Groups are soft-deleted (`deleted_at`): a deleted group's members are removed and its handle is
--   held for 30 days (Platform §4 "Group -> delete"). Names are unique among groups that aren't
--   deleted, ignoring ASCII case **(default)**, so a deleted group's name can be used again.
-- - group_members.role: manager | member, a fixed set, so it keeps a CHECK (TDD §2.1, Permissions §9).
--   A group manager is a property of membership, not a workspace role (Identity §3).
-- - User rows are anonymised, never deleted (Platform §3.1), so ON DELETE never fires for users; the
--   erase step deletes a deleted member's group_members rows itself.
-- One logical change; safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,                     -- ULID
  name TEXT NOT NULL,
  handle TEXT,                             -- copy of the authoritative handles row (lowercase)
  description TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_name_live ON groups(name COLLATE NOCASE) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('manager', 'member')),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id);
