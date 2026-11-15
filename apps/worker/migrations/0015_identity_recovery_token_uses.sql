-- recovery_token_uses: RECOVERY_TOKEN values already used (Identity §4.6, §5). M1a only reads it: the
-- permission engine's "RECOVERY_TOKEN set and unconsumed" fact (owners' invite gate, promotion). Owner
-- recovery, which writes it, arrives in M1c. Safe to re-run (TDD §6.5).
CREATE TABLE IF NOT EXISTS recovery_token_uses (
  token_hash TEXT PRIMARY KEY,             -- HMAC(TOKEN_HASH_KEY, secret)
  owner_id TEXT REFERENCES users(id),
  used_at INTEGER NOT NULL
);
