-- Installation: when the pending domain move expires, 24 hours after it started (Identity §2 default;
-- TDD §2.1; Platform §11; M1c). The hourly identity repair job clears an expired move and audits it.
-- One ALTER per file (see 0025). Nullable (expand).
ALTER TABLE installation ADD COLUMN pending_origin_expires_at INTEGER;
