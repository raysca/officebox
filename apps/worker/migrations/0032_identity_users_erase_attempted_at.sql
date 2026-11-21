-- Users: when the erase of a deleted member was last attempted (Platform §3.1; M1e). The hourly repair
-- job retries unfinished erases oldest attempt first, so a row that keeps failing (an R2 object that
-- won't delete, say) can't starve the others. NULL until the first attempt.
-- One ALTER per file: SQLite has no ADD COLUMN IF NOT EXISTS, so a file with a single statement is
-- either fully applied or not at all, and D1's migrations table stops it running twice (TDD §6.5).
-- Nullable, so older code is unaffected (expand).
ALTER TABLE users ADD COLUMN erase_attempted_at INTEGER;
