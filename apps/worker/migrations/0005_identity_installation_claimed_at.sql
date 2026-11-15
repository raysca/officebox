-- Installation: when setup was claimed (TDD §2.1, §6.8; Platform §14). An incomplete claim expires 24 hours
-- after this time. One ALTER per file: SQLite has no ADD COLUMN IF NOT EXISTS, so a file with a single
-- statement is either fully applied or not at all, and D1's migrations table stops it running twice
-- (TDD §6.5). Nullable, so older code is unaffected (expand).
ALTER TABLE installation ADD COLUMN setup_claimed_at INTEGER;
