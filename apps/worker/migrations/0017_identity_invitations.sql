-- Invitations: the TDD §2.1 core table with the Identity §5 columns folded into the baseline
-- (Platform §14), so no later slice rebuilds it.
--
-- - email is NOT NULL: copy-link invitations are bound to the invited email (Identity §4.2).
-- - email_normalised (trim, lowercase, NFKC) carries the one-pending-invitation-per-email index.
-- - role: admin | member (Zod in packages/shared; the API lets only owners invite admins). No CHECK,
--   because the list may grow (Platform §14).
-- - token_hash = HMAC(TOKEN_HASH_KEY, token); the raw token is only ever in the link's fragment.
--   token_nonce lets the Worker rebuild the same link for "copy again" (Identity §4.2): the token is
--   HMAC(TOKEN_HASH_KEY, 'invitation-link:' || nonce), so the link can't be rebuilt from D1 alone.
-- - accepted_attempt_id is set by the accept compare-and-set; users.created_attempt_id and
--   handles.created_attempt_id carry the same ULID (whose timestamp is when the invitation was
--   consumed), and accepted_by / accepted_at finish the accept (Identity §4.3; the repair job).
-- - group_ids (JSON array) is in the baseline for M1e; M1b never sets it.
-- - last_sent_at: when the invitation email was last queued (resend), for the invitations list.
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  email_normalised TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  token_nonce TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT REFERENCES users(id),
  accepted_attempt_id TEXT,
  revoked_at INTEGER,
  group_ids TEXT,
  last_sent_at INTEGER,
  created_at INTEGER NOT NULL
);
-- One pending invitation per normalised email (expired ones are revoked on re-invite).
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_email ON invitations(email_normalised)
  WHERE accepted_at IS NULL AND accepted_attempt_id IS NULL AND revoked_at IS NULL;
-- The repair job's scan: consumed but not finished.
CREATE INDEX IF NOT EXISTS invitations_in_flight ON invitations(accepted_attempt_id)
  WHERE accepted_attempt_id IS NOT NULL AND accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS handles_created_attempt ON handles(created_attempt_id) WHERE created_attempt_id IS NOT NULL;
