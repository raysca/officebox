-- Release an unfinished setup claim at once (Identity §4.1 "Operator recovery"; TDD §6.8; M1b-1).
--
--   npx wrangler d1 execute officebox --remote --file scripts/setup-release.sql
--
-- This is the 24-hour expiry batch without the age condition. It deletes the claimed owner (with their
-- handle; their tickets and resume code go with the user row) only if that owner has no passkey, has
-- never signed in and setup isn't complete, and it clears the claim only if no owner row for it
-- remains. So it never removes an owner who registered a passkey or signed in, and it never leaves a
-- half-cleared claim. Safe to re-run: a second run changes nothing more.
--
-- Only when it releases a claim, it also sets setup_opened_at to 0, which ends the open claim window:
-- setup reopens in token mode (the SETUP_TOKEN secret, or a new generated token in Workers Logs). The
-- Worker writes the `setup.released_outside_app` audit entry the next time it sees the 0 (a setup
-- request or the hourly repair job), then sets it to -1.
--
-- A claim someone else already completed can't be undone here: start over with a fresh deployment
-- (docs/deployment.md).

DELETE FROM users
 WHERE created_attempt_id = (SELECT setup_claim FROM installation WHERE id = 1)
   AND role = 'owner'
   AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = users.id)
   AND first_signed_in_at IS NULL
   AND (SELECT setup_completed_at FROM installation WHERE id = 1) IS NULL;

DELETE FROM handles
 WHERE created_attempt_id = (SELECT setup_claim FROM installation WHERE id = 1)
   AND NOT EXISTS (SELECT 1 FROM users WHERE created_attempt_id = (SELECT setup_claim FROM installation WHERE id = 1))
   AND (SELECT setup_completed_at FROM installation WHERE id = 1) IS NULL;

UPDATE installation
   SET setup_claim = NULL, setup_claimed_at = NULL, canonical_origin = NULL, allowed_hosts = NULL,
       setup_token_hash = NULL, setup_token_expires_at = NULL, setup_opened_at = 0
 WHERE id = 1 AND setup_completed_at IS NULL AND setup_claim IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM users WHERE created_attempt_id = installation.setup_claim);
