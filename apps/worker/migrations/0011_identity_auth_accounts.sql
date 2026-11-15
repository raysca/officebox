-- auth_accounts: better-auth's `account` model, mapped (Identity §5; Platform §14). Required by
-- better-auth; passkey sign-in keeps no secrets here. password is always NULL (email and password is
-- disabled); the OAuth token columns stay unused until SSO (Phase 2).
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS auth_accounts (
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
CREATE INDEX IF NOT EXISTS auth_accounts_user ON auth_accounts(user_id);
