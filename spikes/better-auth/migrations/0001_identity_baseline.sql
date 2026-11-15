-- Spike schema: our table and column names (Identity §5), with better-auth's models mapped onto them.
-- Hand-written from the generated SQL (scripts/generate-schema.mjs prints it), then edited to our names.
-- Dates are INTEGER epoch milliseconds: src/epoch-ms.ts converts better-auth's ISO strings at the Kysely layer.

CREATE TABLE IF NOT EXISTS installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_name TEXT NOT NULL,
  canonical_origin TEXT,
  allowed_hosts TEXT,
  pending_origin TEXT,
  setup_claimed_at INTEGER,
  setup_completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS users (                     -- better-auth `user`
  id TEXT PRIMARY KEY,                                 -- ULID (advanced.database.generateId)
  display_name TEXT NOT NULL,                          -- name
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,           -- emailVerified
  avatar_key TEXT,                                     -- image
  role TEXT NOT NULL DEFAULT 'member',                 -- additionalFields, input: false
  status TEXT NOT NULL DEFAULT 'active',
  handle TEXT,
  email_normalised TEXT,
  first_signed_in_at INTEGER,
  created_attempt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalised ON users(email_normalised) WHERE email_normalised IS NOT NULL;

CREATE TABLE IF NOT EXISTS handles (
  handle TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT
);

CREATE TABLE IF NOT EXISTS sessions (                  -- better-auth `session`
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  device_label TEXT,
  approx_location TEXT,
  fresh_auth_at INTEGER,
  fresh_auth_method TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_accounts (             -- better-auth `account`
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_verifications (        -- better-auth `verification`
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_verifications_identifier ON auth_verifications(identifier);

CREATE TABLE IF NOT EXISTS passkeys (                  -- @better-auth/passkey `passkey`
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,               -- counter
  verified_sign_count INTEGER NOT NULL DEFAULT 0,      -- ours (kept only if the spike says so)
  created_via TEXT NOT NULL DEFAULT 'signed_in',       -- ours; set by our after hook
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  transports TEXT,
  aaguid TEXT,
  name TEXT,
  created_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (               -- ours: enrolment tickets (spike subset)
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_link_issues (         -- ours, beside better-auth's verification row
  token_hash TEXT PRIMARY KEY,
  email_normalised TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_counters (             -- ours: atomic counters for the limiter backstop
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Spike-only tables: captured mail and raised security notices, so tests can assert on them.
CREATE TABLE IF NOT EXISTS spike_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token TEXT NOT NULL,
  better_auth_url TEXT NOT NULL,
  our_link TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS security_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);
