-- M2a: short-lived, single-use WebSocket upgrade tickets (TDD §3.1, §4.2).
-- Used as a fallback when cookies cannot be sent on the WebSocket handshake; bound to a specific
-- target ('hub' or '<kind>:<roomId>'), expires in 30 seconds, consumed atomically on upgrade.
CREATE TABLE IF NOT EXISTS ws_tickets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  target TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ws_tickets_expires ON ws_tickets(expires_at);
