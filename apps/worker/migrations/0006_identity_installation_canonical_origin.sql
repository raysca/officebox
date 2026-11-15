-- Installation: the canonical origin (Identity §2, §4.4; TDD §2.1, §8.1; Platform §14). Recorded at the
-- setup claim; the passkey relying-party ID, better-auth's baseURL and trustedOrigins, the Origin checks
-- and every emailed link come from it. Workspace state, not configuration (AGENTS §4.1).
-- One ALTER per file (see 0005). Nullable (expand).
ALTER TABLE installation ADD COLUMN canonical_origin TEXT;
