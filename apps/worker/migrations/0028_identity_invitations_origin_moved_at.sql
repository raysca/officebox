-- Invitations: when a committed domain move invalidated this unfinished invitation's link (Identity §4.4;
-- M1c). The commit replaces the stored token hash, so the old link stops working, and records the time
-- here; the admin list flags the invitation until "Copy again" or "Resend" makes a new link, which clears
-- it. One ALTER per file (see 0025). Nullable (expand).
ALTER TABLE invitations ADD COLUMN origin_moved_at INTEGER;
