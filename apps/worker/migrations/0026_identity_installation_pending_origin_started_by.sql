-- Installation: the owner who started the pending domain move (Identity §4.4; TDD §2.1; M1c). Only that
-- owner's move link can commit it. One ALTER per file (see 0025). Nullable (expand).
ALTER TABLE installation ADD COLUMN pending_origin_started_by TEXT;
