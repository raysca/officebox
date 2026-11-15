-- Audit log. TDD §2.1. Never stores message or document content, raw emails or tokens (Platform §3.1);
-- metadata is sanitised by the writer (apps/worker/src/core/audit.ts).
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log(actor_id, created_at);
