-- Cron overlap guard (TDD §7.8): one lease per schedule, so a trigger that fires while the previous
-- run of the same schedule is still going skips instead of running its jobs twice.
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS cron_leases (
  schedule TEXT PRIMARY KEY,   -- five_minutes | hourly | daily (Zod-validated)
  holder TEXT NOT NULL,        -- ULID of the run holding the lease
  expires_at INTEGER NOT NULL  -- UTC ms; an expired lease can be taken over
);
