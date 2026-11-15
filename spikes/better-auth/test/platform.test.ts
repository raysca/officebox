// Q11 platform: nodejs_compat on our compatibility date, and D1's "only if matched" conditional batch (TDD §6.8).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Q11 nodejs_compat (this Worker sets the flag; scripts/nodejs-compat.mjs checks without it)", () => {
  it("AsyncLocalStorage is available the way better-auth looks for it", async () => {
    const proc = (globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } }).process;
    expect(typeof proc?.getBuiltinModule).toBe("function");
    const mod = proc!.getBuiltinModule!("node:async_hooks") as { AsyncLocalStorage?: unknown };
    expect(typeof mod.AsyncLocalStorage).toBe("function");
  });
});

describe("Q11 D1 conditional batch (setup-claim expiry, TDD §6.8)", () => {
  async function seed(ownerId: string, withPasskey: boolean) {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS t_inst (id INTEGER PRIMARY KEY, owner TEXT, claim TEXT, claimed_at INTEGER, completed_at INTEGER, origin TEXT)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS t_users (id TEXT PRIMARY KEY, first_signed_in_at INTEGER)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS t_passkeys (id TEXT PRIMARY KEY, user_id TEXT)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS t_handles (handle TEXT PRIMARY KEY, owner_id TEXT)"),
    ]);
    const instId = Math.floor(Math.random() * 1e9);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO t_inst (id, owner, claim, claimed_at, completed_at, origin) VALUES (?, ?, 'nonce', ?, NULL, 'https://officebox.test')").bind(instId, ownerId, Date.now() - 90_000_000),
      env.DB.prepare("INSERT INTO t_users (id) VALUES (?)").bind(ownerId),
      env.DB.prepare("INSERT INTO t_handles (handle, owner_id) VALUES (?, ?)").bind(`h-${ownerId}`, ownerId),
      ...(withPasskey ? [env.DB.prepare("INSERT INTO t_passkeys (id, user_id) VALUES (?, ?)").bind(`pk-${ownerId}`, ownerId)] : []),
    ]);
    return instId;
  }
  function expiryBatch(instId: number, ownerId: string) {
    const now = Date.now();
    return [
      env.DB.prepare(
        `DELETE FROM t_users WHERE id = ?1 AND first_signed_in_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM t_passkeys WHERE user_id = ?1)
           AND (SELECT completed_at FROM t_inst WHERE id = ?2) IS NULL
           AND (SELECT claimed_at FROM t_inst WHERE id = ?2) < ?3`,
      ).bind(ownerId, instId, now - 86_400_000),
      // "only if matched": changes() is the previous statement's row count inside the same batch
      env.DB.prepare("DELETE FROM t_handles WHERE owner_id = ?1 AND changes() > 0").bind(ownerId),
      env.DB.prepare(
        "UPDATE t_inst SET claim = NULL, claimed_at = NULL, origin = NULL WHERE id = ?1 AND completed_at IS NULL AND NOT EXISTS (SELECT 1 FROM t_users WHERE id = ?2)",
      ).bind(instId, ownerId),
    ];
  }

  it("changes() > 0 sees the previous statement in the batch: the claim is cleared when the delete matched", async () => {
    const owner = crypto.randomUUID();
    const inst = await seed(owner, false);
    const res = await env.DB.batch(expiryBatch(inst, owner));
    expect(res.map((r) => r.meta.changes)).toEqual([1, 1, 1]);
    expect(await env.DB.prepare("SELECT claim, origin FROM t_inst WHERE id = ?").bind(inst).first()).toEqual({ claim: null, origin: null });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM t_handles WHERE owner_id = ?").bind(owner).first()).toEqual({ n: 0 });
  });

  it("…and nothing is cleared when the delete didn't match (owner has a passkey)", async () => {
    const owner = crypto.randomUUID();
    const inst = await seed(owner, true);
    const res = await env.DB.batch(expiryBatch(inst, owner));
    expect(res.map((r) => r.meta.changes)).toEqual([0, 0, 0]);
    expect(await env.DB.prepare("SELECT claim FROM t_inst WHERE id = ?").bind(inst).first()).toEqual({ claim: "nonce" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM t_handles WHERE owner_id = ?").bind(owner).first()).toEqual({ n: 1 });
  });

  it("changes() after an UPDATE: the TDD's literal form (UPDATE … AND changes() > 0 right after the DELETE) works too", async () => {
    const owner = crypto.randomUUID();
    const inst = await seed(owner, false);
    const res = await env.DB.batch([
      expiryBatch(inst, owner)[0]!,
      env.DB.prepare("UPDATE t_inst SET claim = NULL, claimed_at = NULL, origin = NULL WHERE id = ?1 AND completed_at IS NULL AND changes() > 0").bind(inst),
    ]);
    expect(res.map((r) => r.meta.changes)).toEqual([1, 1]);
  });

  it("a D1 batch is atomic: a failing statement rolls back the earlier ones", async () => {
    const owner = crypto.randomUUID();
    const inst = await seed(owner, false);
    await expect(
      env.DB.batch([
        env.DB.prepare("UPDATE t_inst SET claim = 'changed' WHERE id = ?").bind(inst),
        env.DB.prepare("INSERT INTO t_users (id) VALUES (?)").bind(owner), // duplicate primary key
      ]),
    ).rejects.toThrow();
    expect(await env.DB.prepare("SELECT claim FROM t_inst WHERE id = ?").bind(inst).first()).toEqual({ claim: "nonce" });
  });
});
