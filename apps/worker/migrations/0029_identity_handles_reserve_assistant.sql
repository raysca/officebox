-- Handles: reserve the handle derived from the assistant's default display name (Identity §4.8,
-- Assistant §2, §14.2; M1d). The static reserved words (assistant, everyone, …) are refused by the
-- shared handle rules; this one depends on the `assistant_display_name` setting (default "Butler"), so
-- it is a `handles` row with owner_type 'reserved' that a rename releases after the usual 30-day hold.
-- If a member already holds `butler`, INSERT OR IGNORE leaves it theirs, as the spec says for a rename.
-- One logical change; safe to re-run (TDD §6.5).
INSERT OR IGNORE INTO handles (handle, owner_type, owner_id) VALUES ('butler', 'reserved', 'assistant');
