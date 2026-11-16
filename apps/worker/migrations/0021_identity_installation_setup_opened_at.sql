-- Installation: the start of the open claim window (Identity §4.1; TDD §2.1, §6.8; Platform §14; M1b-1).
-- Written once, by the first setup request that finds every required service passing; 0 after the
-- operator's setup release (scripts/setup-release.sql), -1 once the Worker has audited that release.
-- One ALTER per file: SQLite has no ADD COLUMN IF NOT EXISTS, so a file with a single statement is
-- either fully applied or not at all, and D1's migrations table stops it running twice (TDD §6.5).
-- Nullable, so older code is unaffected (expand).
ALTER TABLE installation ADD COLUMN setup_opened_at INTEGER;
