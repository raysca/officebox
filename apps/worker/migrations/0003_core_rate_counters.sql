-- D1 rate counters for windows longer than 60 seconds and daily quotas (Platform §8, §14).
-- Excluded from export (Platform §6). Rows older than the longest window are pruned daily.
-- Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS rate_counters (
  scope TEXT NOT NULL,          -- the limit's name, e.g. 'group_dm_create'
  key TEXT NOT NULL,            -- user ID, IP or workspace
  window_start INTEGER NOT NULL, -- UTC ms
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, key, window_start)
);
CREATE INDEX IF NOT EXISTS rate_counters_window ON rate_counters(window_start);
