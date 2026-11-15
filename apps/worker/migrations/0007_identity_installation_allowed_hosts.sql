-- Installation: hosts that redirect to the canonical origin, as a JSON array (Identity §2, §4.4; TDD §2.1).
-- Starts as the setup claim's host alone; a committed domain move (M1c) appends the old host.
-- One ALTER per file (see 0005). Nullable (expand).
ALTER TABLE installation ADD COLUMN allowed_hosts TEXT;
