-- Users: the TDD §2.1 core table with the Identity §5 columns folded into the baseline (Platform §14),
-- so later slices never rebuild it. M1a uses id, email, display_name, handle, password_hash, role,
-- status, session_epoch and the timestamps; the profile, onboarding and security-notice columns are
-- filled by M1c-M1e. Safe to re-run (TDD §6.5).
-- Edited before its first merge (M1a review added password_version; the Assistant spec added status 'system');
-- no deployment ever ran an earlier version.
--
-- role: owner | admin | member | guest (guest reserved for Phase 2). Validated with Zod in
-- packages/shared, not a CHECK, because the list may grow (Platform §14). status is a fixed set.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,        -- NULL only once deleted; stored lower-cased
  display_name TEXT NOT NULL,
  handle TEXT,                             -- copy of the authoritative handles row (Identity §5)
  password_hash TEXT,                      -- pbkdf2-sha256-hmac$<pepperId>$<iterations>$<salt>$<hash>
  password_version INTEGER NOT NULL DEFAULT 1, -- bumped by a real password change or reset, never a re-hash; binds ob_device
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted', 'system')), -- 'system': reserved non-user senders (system, assistant); never sign in (Identity §4.8)
  session_epoch INTEGER NOT NULL DEFAULT 0, -- increment to invalidate every session (TDD §8.1)
  avatar_key TEXT,                         -- R2 key (M1d)
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
  pending_security_notice TEXT,            -- JSON (Identity §4.6)
  admin_reset_at INTEGER,                  -- no-email recovery flag shown to owners (Identity §4.6)
  admin_reset_by TEXT,
  admin_reset_acknowledged_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (status IN ('deleted', 'system') OR email IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS users_role_status ON users(role, status);
