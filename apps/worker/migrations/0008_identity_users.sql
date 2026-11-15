-- Users: the TDD §2.1 core table with the Identity §5 columns folded into the baseline (Platform §14),
-- so later slices never rebuild it. better-auth's `user` model is mapped onto it (Identity §5):
-- name -> display_name, emailVerified -> email_verified, image -> avatar_key; role, status, handle,
-- email_normalised, first_signed_in_at and created_attempt_id are additionalFields with input: false.
-- Reconciled with the M1a-0 spike's baseline (spikes/better-auth/migrations/0001_identity_baseline.sql).
-- No password_hash and no session_epoch: sign-in is passwordless and revocation deletes sessions.
-- Dates are INTEGER epoch ms (better-auth's created_at/updated_at through the epoch-ms Kysely plugin).
-- Safe to re-run (TDD §6.5).
--
-- role: owner | admin | member | guest (guest reserved for Phase 2). Validated with Zod in
-- packages/shared, not a CHECK, because the list may grow (Platform §14). status is a fixed set.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                     -- ULID (advanced.database.generateId), or a reserved id
  email TEXT UNIQUE COLLATE NOCASE,        -- as entered, for display; NULL only once deleted (and on reserved rows)
  email_normalised TEXT,                   -- trim, lowercase, NFKC: lookup, uniqueness, limiter keys
  display_name TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0, -- better-auth's emailVerified
  handle TEXT,                             -- copy of the authoritative handles row (Identity §5)
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted', 'system')),
  first_signed_in_at INTEGER,              -- first session; gates setup resume and invitation reopening
  created_attempt_id TEXT,                 -- the setup claim or invitation accept attempt that created the user
  avatar_key TEXT,                         -- R2 key (M1d); better-auth's image, written only by our profile API
  timezone TEXT NOT NULL DEFAULT 'UTC',
  working_hours TEXT,                      -- JSON: { mon: [["09:00","17:00"]], ... }
  region TEXT,                             -- ISO 3166-1/-2
  job_title TEXT,
  team TEXT,
  pronouns TEXT,
  phone TEXT,
  location TEXT,
  status_emoji TEXT,
  status_text TEXT,
  status_expires_at INTEGER,
  onboarded_at INTEGER,
  tour_dismissed_at INTEGER,
  pending_security_notice TEXT,            -- JSON list of notices; banner until acknowledged on a fresh passkey sign-in (Identity §4.6a)
  admin_reset_at INTEGER,                  -- no-email recovery flag shown to owners (Identity §4.6)
  admin_reset_by TEXT,
  admin_reset_acknowledged_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (status IN ('deleted', 'system') OR email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalised ON users(email_normalised) WHERE email_normalised IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_role_status ON users(role, status);
CREATE INDEX IF NOT EXISTS users_created_attempt ON users(created_attempt_id) WHERE created_attempt_id IS NOT NULL;

-- Reserved non-user rows (TDD §2.1, Assistant §14.2): senders that messages.sender_id can reference.
-- status 'system': never an actor, never in the directory or seat counts, never signs in.
INSERT OR IGNORE INTO users (id, email, display_name, role, status, created_at, updated_at)
VALUES ('system', NULL, 'System', 'member', 'system', 0, 0);
INSERT OR IGNORE INTO users (id, email, display_name, role, status, created_at, updated_at)
VALUES ('assistant', NULL, 'Assistant', 'member', 'system', 0, 0);
