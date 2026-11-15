-- auth_tokens: our own single-use tokens (Identity §5; TDD §8.1). M1a issues passkey enrolment tickets
-- (kind 'passkey_enrol'); recovery links and email changes arrive in M1c. Stored as
-- HMAC(TOKEN_HASH_KEY, token); consumed by compare-and-set on used_at.
-- kind: recovery | email_change | passkey_enrol (Zod, no CHECK; Platform §14).
-- payload (JSON): passkey_enrol: { "via": "...", "claim": "...", "challenge": "..." }.
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  issued_by TEXT REFERENCES users(id),
  payload TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id, kind);
