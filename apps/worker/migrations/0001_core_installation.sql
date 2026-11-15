-- Installation (single row). TDD §2.1.
-- Safe to re-run (TDD §6.5): IF NOT EXISTS, no data changes. The row itself is created by first-run
-- setup (M1), not here, because installation_id and name come from setup.
CREATE TABLE IF NOT EXISTS installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  setup_token_hash TEXT,               -- generated-token mode only; cleared on setup (TDD §6.8)
  setup_token_expires_at INTEGER,
  setup_claim TEXT,                    -- nonce of the request that completed setup
  setup_completed_at INTEGER,
  latest_release TEXT,                 -- JSON from the daily release check (TDD §6.7)
  settings TEXT NOT NULL DEFAULT '{}'  -- JSON: admin settings (Platform §7)
);
