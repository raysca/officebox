-- Handles: one namespace for people and groups (Identity §4.8, §5). Authoritative; users.handle and
-- (from M1e) groups.handle are copies written in the same transaction. Handles are stored lower-cased,
-- so the primary key makes them unique ignoring case.
-- owner_type: user | group | reserved (a fixed set, so the CHECK stays; TDD §2.1).
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS handles (
  handle TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'group', 'reserved')),
  owner_id TEXT,
  released_at INTEGER                      -- held for 30 days after a change (M1d)
);
CREATE INDEX IF NOT EXISTS handles_owner ON handles(owner_type, owner_id);
