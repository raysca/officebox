-- Sessions: better-auth's `session` model, mapped (TDD §2.1, §8.1; Identity §4.5, §5).
-- userId -> user_id, expiresAt -> expires_at, ipAddress -> ip_address, userAgent -> user_agent;
-- device_label, approx_location, fresh_auth_at and fresh_auth_method are additionalFields set by
-- databaseHooks.session.create.before. No refresh token, epoch or revoked_at: revoking deletes the row.
-- The token is better-auth's session token; the cookie carries it signed with BETTER_AUTH_SECRET.
-- created_at, updated_at and expires_at are INTEGER epoch ms through the epoch-ms Kysely plugin.
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,             -- last refresh + 30 days (sliding)
  ip_address TEXT,
  user_agent TEXT,
  device_label TEXT,                       -- e.g. "Chrome on macOS"
  approx_location TEXT,                    -- city and country from request.cf, if available
  fresh_auth_at INTEGER,                   -- last fresh authentication on this session (step-up, Identity §4.5)
  fresh_auth_method TEXT,                  -- passkey | magic_link (only passkey satisfies step-up; Zod)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL              -- last refresh of the sliding expiry ("last seen", at most a day old)
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
