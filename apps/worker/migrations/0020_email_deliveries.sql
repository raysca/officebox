-- email_deliveries: one row per email job (TDD §7.6). The row's id is the job ID, carried in the
-- `email` queue message and passed to providers that take an idempotency key, so a redelivered
-- message never sends twice once it has been marked sent. Permanent failures are recorded with the
-- provider's error code; messages that exhaust their 8 tries are marked dead and go to the DLQ.
-- Admin health (M7) reads failures from here.
--
-- Never holds the email itself: no recipient address (only an HMAC of it), no subject, no body, no
-- link. state: queued | sent | failed | dead (Zod, no CHECK; Platform §14). kind: invitation |
-- magic_link | security_notice | test.
-- Excluded from exports (an operational table). Deleted 30 days after creation (default; TDD §7.8).
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  driver TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_deliveries_state ON email_deliveries(state, updated_at);
CREATE INDEX IF NOT EXISTS email_deliveries_created ON email_deliveries(created_at);
