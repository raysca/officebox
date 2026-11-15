-- auth_verifications: better-auth's `verification` model, mapped (Identity §5; Platform §14): its
-- short-lived values, here the WebAuthn challenges (and magic-link tokens, hashed, from M1b).
-- Consumed by better-auth with one atomic DELETE … RETURNING. Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS auth_verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_verifications_identifier ON auth_verifications(identifier);
CREATE INDEX IF NOT EXISTS auth_verifications_expires ON auth_verifications(expires_at);
