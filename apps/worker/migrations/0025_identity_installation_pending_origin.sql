-- Installation: the two-step domain move's pending origin (Identity §2, §4.4; TDD §2.1, §8.1; Platform §14;
-- M1c). Set when an owner starts a move (with step-up); the move commits only when that owner registers a
-- passkey on this origin, and it is cleared at commit, on cancel and when it expires (24 hours, default).
-- One ALTER per file: SQLite has no ADD COLUMN IF NOT EXISTS, so a file with a single statement is either
-- fully applied or not at all, and D1's migrations table stops it running twice (TDD §6.5).
-- Nullable, so older code is unaffected (expand).
ALTER TABLE installation ADD COLUMN pending_origin TEXT;
