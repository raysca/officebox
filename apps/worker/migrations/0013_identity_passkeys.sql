-- Passkeys: @better-auth/passkey's `passkey` model, mapped (Identity §4.4, §5; Platform §14).
-- credentialID -> credential_id, publicKey -> public_key, counter -> sign_count, userId -> user_id,
-- deviceType -> device_type, backedUp -> backed_up. Ours: created_via and last_used_at.
-- No verified_sign_count: the M1a-0 spike showed SimpleWebAuthn refuses counter regressions itself, and
-- clones are identified by re-verifying the refused assertion (TDD §8.1).
-- created_via has a DB default because better-auth inserts the row without knowing the column; our
-- after hook then sets the real value. better-auth requires device_type and backed_up, and leaves
-- created_at nullable. Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,      -- base64url
  public_key TEXT NOT NULL,                -- COSE key, base64
  sign_count INTEGER NOT NULL DEFAULT 0,   -- better-auth's counter
  created_via TEXT NOT NULL DEFAULT 'signed_in', -- setup | invitation | recovery_link | owner_recovery | magic_link | signed_in | domain_move (Zod)
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  transports TEXT,                         -- comma-separated, as better-auth stores them
  aaguid TEXT,
  name TEXT,
  created_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
