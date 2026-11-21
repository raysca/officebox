import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { audit, auditStatement, sanitiseMetadata } from "../src/core/audit";
import type { CoreContext } from "../src/core/context";
import { createLogger } from "../src/core/log";
import {
  clearSettingsCache,
  defineSetting,
  SETTINGS,
  SETTINGS_CACHE_TTL_MS,
  SettingsStore,
  type SettingsRegistry,
} from "../src/core/settings";

const quiet = createLogger({}, () => {});
const ctx = (overrides: Partial<CoreContext> = {}): CoreContext => ({ env, log: quiet, now: Date.now, ...overrides });

interface AuditRow {
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: string | null;
}

const auditRows = async (targetId: string) =>
  (
    await env.DB.prepare(
      "SELECT actor_id, action, target_type, target_id, metadata FROM audit_log WHERE target_id = ? ORDER BY id",
    )
      .bind(targetId)
      .all<AuditRow>()
  ).results;

describe("audit log", () => {
  it("writes an entry with actor, action, target and sanitised metadata", async () => {
    const target = crypto.randomUUID();
    await audit(ctx(), {
      action: "member.disable",
      actor: "01HZACTOR",
      target: { type: "user", id: target },
      metadata: { reason: "left the company", count: 2 },
    });
    expect(await auditRows(target)).toEqual([
      {
        actor_id: "01HZACTOR",
        action: "member.disable",
        target_type: "user",
        target_id: target,
        metadata: '{"reason":"left the company","count":2}',
      },
    ]);
  });

  it("never stores raw emails or tokens", async () => {
    const metadata = {
      email: "Alice@Example.com",
      note: "invited bob@example.org by link",
      password: "hunter2",
      setupToken: "abc",
      nested: { list: ["carol@example.net"], header: "Bearer abc.def.ghi" },
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
      opaque: "Zx9QmT4rLk2Vb8Nw1Yc7Hd3Fg6Js5Pa0",
      id: "01J9ZQ8V6N3X2K4M5P7R8S9T0V",
    };
    const masked = JSON.parse((await sanitiseMetadata({}, metadata)) ?? "{}") as Record<string, unknown>;
    expect(masked).toEqual({
      email: "[email]",
      note: "invited [email] by link",
      password: "[redacted]",
      setupToken: "[redacted]",
      nested: { list: ["[email]"], header: "Bearer [redacted]" },
      jwt: "[redacted]",
      opaque: "[redacted]",
      id: "01J9ZQ8V6N3X2K4M5P7R8S9T0V",
    });

    // With the hash key (M1), the same address always maps to the same pseudonym, case-insensitively.
    const hashed = JSON.parse(
      (await sanitiseMetadata({ TOKEN_HASH_KEY: "test-key" }, { a: "alice@example.com", b: "ALICE@example.com" })) ??
        "{}",
    ) as { a: string; b: string };
    expect(hashed.a).toMatch(/^email:[0-9a-z]{26}$/);
    expect(hashed.b).toBe(hashed.a);
    expect(JSON.stringify(hashed)).not.toContain("alice");
  });

  it("caps oversized metadata and refuses malformed actions", async () => {
    expect(await sanitiseMetadata({}, { blob: Array.from({ length: 100 }, () => "y ".repeat(200)) })).toBe(
      '{"truncated":true}',
    );
    expect(await sanitiseMetadata({}, {})).toBeNull();
    await expect(auditStatement(ctx(), { action: "Bad Action", actor: null })).rejects.toThrow(/Invalid audit action/);
  });

  it("takes a caller's ID, and writes with `when` only while the condition holds (M1e)", async () => {
    const target = crypto.randomUUID();
    const id = "01J00000000000000000000AUD";
    const yes = await auditStatement(
      ctx(),
      { action: "member.signed_out", actor: null, target: { type: "user", id: target } },
      { id, when: { sql: "? = ?", params: [1, 1] } },
    );
    const no = await auditStatement(
      ctx(),
      { action: "member.signed_out", actor: null, target: { type: "user", id: target } },
      { when: { sql: "? = ?", params: [1, 2] } },
    );
    await env.DB.batch([yes, no]);
    const rows = await auditRows(target);
    expect(rows).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE id = ?").bind(id).first<{ n: number }>(),
    ).toEqual({ n: 1 });
    await expect(
      auditStatement(
        ctx(),
        { action: "a.b", actor: null },
        { onlyIfPreviousChanged: true, when: { sql: "1", params: [] } },
      ),
    ).rejects.toThrow(/not both/);
  });
});

describe("settings store", () => {
  // Storage is shared between tests in this file (AGENTS §5), so every test uses its own keys. The
  // installation row is shared and created once; keys never collide.
  const makeRegistry = () => {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const flag = `flag_${id}`;
    const limit = `limit_${id}`;
    const contact = `contact_${id}`;
    const registry = {
      [flag]: defineSetting<unknown>({
        key: flag,
        schema: z.boolean(),
        default: true,
        changeableBy: "admin",
        auditAction: "settings.test_flag",
      }),
      [limit]: defineSetting<unknown>({
        key: limit,
        schema: z.number().int().positive(),
        default: 1000,
        changeableBy: "admin",
        auditAction: "settings.test_limit",
      }),
      [contact]: defineSetting<unknown>({
        key: contact,
        schema: z.email().nullable(),
        default: null,
        changeableBy: "owner",
        auditAction: "settings.test_contact",
        personal: true,
      }),
    } satisfies SettingsRegistry;
    return { registry, flag, limit, contact };
  };

  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO installation (id, installation_id, name, settings) VALUES (1, 'inst', 'Test', '{}')",
    ).run();
    clearSettingsCache(env.DB);
  });

  it("refuses an invalid definition or registry", () => {
    expect(() =>
      defineSetting({ key: "Bad-Key", schema: z.boolean(), default: true, changeableBy: "admin", auditAction: "a.b" }),
    ).toThrow();
    expect(() =>
      defineSetting({
        key: "x",
        schema: z.boolean(),
        default: 1 as unknown as boolean,
        changeableBy: "admin",
        auditAction: "a.b",
      }),
    ).toThrow();
    const good = defineSetting<unknown>({
      key: "good",
      schema: z.boolean(),
      default: true,
      changeableBy: "admin",
      auditAction: "a.b",
    });
    expect(() => new SettingsStore(ctx(), { other: good })).toThrow(/equal to its definition/);
    expect(() => new SettingsStore(ctx(), { "x') OR 1=1 --": good })).toThrow();
    expect(() => new SettingsStore(ctx(), SETTINGS)).not.toThrow();
  });

  it("reads defaults and refuses writes before setup", async () => {
    // A database with no installation row (setup hasn't run).
    const empty = {
      prepare: (sql: string) =>
        env.DB.prepare(sql.includes("FROM installation") ? "SELECT settings FROM installation WHERE 0" : sql),
      batch: (s: D1PreparedStatement[]) => env.DB.batch(s),
    } as unknown as D1Database;
    const { registry, flag } = makeRegistry();
    const store = new SettingsStore(ctx({ env: { ...env, DB: empty } }), registry);
    expect(await store.get(flag)).toBe(true);
    const result = await store.set(flag, false, "01HZADMIN");
    expect(!result.ok && result.error.code).toBe("unavailable");
  });

  it("gets, sets and lists typed values, auditing each change", async () => {
    const { registry, flag, limit } = makeRegistry();
    const store = new SettingsStore(ctx(), registry);

    expect(await store.get(limit)).toBe(1000);
    const set = await store.set(limit, 1024, "01HZADMIN");
    expect(set).toEqual({ ok: true, value: { key: limit, value: 1024, isDefault: false, changeableBy: "admin" } });
    expect(await store.get(limit)).toBe(1024);

    // Setting the same value again is a no-op without a second audit entry.
    await store.set(limit, 1024, "01HZADMIN");
    expect(await auditRows(limit)).toEqual([
      {
        actor_id: "01HZADMIN",
        action: "settings.test_limit",
        target_type: "setting",
        target_id: limit,
        metadata: JSON.stringify({ old: 1000, new: 1024 }),
      },
    ]);

    const list = await store.list();
    expect(list.find((e) => e.key === limit)).toMatchObject({ value: 1024, isDefault: false });
    expect(list.find((e) => e.key === flag)).toMatchObject({ value: true, isDefault: true });
  });

  it("audits exact old values under concurrent writes", async () => {
    const { registry, limit } = makeRegistry();
    const store = () => new SettingsStore(ctx(), registry);
    const results = await Promise.all([1, 2, 3, 4].map((n) => store().set(limit, 2000 + n, "01HZADMIN")));
    expect(results.every((r) => r.ok || r.error.code === "conflict")).toBe(true);
    const landed = results.filter((r) => r.ok).length;
    expect(landed).toBeGreaterThanOrEqual(1);

    const chain = (await auditRows(limit)).map((r) => JSON.parse(r.metadata ?? "{}") as { old: number; new: number });
    expect(chain.length).toBe(landed);
    expect(chain[0]?.old).toBe(1000);
    for (let i = 1; i < chain.length; i++) expect(chain[i]?.old).toBe(chain[i - 1]?.new);
    clearSettingsCache(env.DB);
    expect(await store().get(limit)).toBe(chain[chain.length - 1]?.new);
  });

  it("returns conflict when another writer keeps changing the key between read and write", async () => {
    const { registry, limit } = makeRegistry();
    let rogue = 5000;
    // Before every batch, another writer changes the key, so the guarded write never matches.
    const contested = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("UPDATE installation SET settings = json_set(settings, ?, json(?)) WHERE id = 1")
          .bind(`$.${limit}`, String(rogue++))
          .run();
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const store = new SettingsStore(ctx({ env: { ...env, DB: contested } }), registry);
    const result = await store.set(limit, 42, "01HZADMIN");
    expect(!result.ok && result.error.code).toBe("conflict");
    expect(await auditRows(limit)).toEqual([]); // no audit entry for writes that didn't happen
  });

  it("doesn't let a read that raced a write repopulate the cache with the old value", async () => {
    const { registry, limit } = makeRegistry();
    const reader = new SettingsStore(ctx(), registry);
    const writer = new SettingsStore(ctx(), registry);
    const [, written] = await Promise.all([reader.get(limit), writer.set(limit, 4242, null)]);
    expect(written.ok).toBe(true);
    expect(await reader.get(limit)).toBe(4242);
  });

  it("validates values and refuses unknown keys", async () => {
    const { registry, limit } = makeRegistry();
    const store = new SettingsStore(ctx(), registry);
    const invalid = await store.set(limit, -5, null);
    expect(!invalid.ok && invalid.error.code).toBe("validation_failed");
    const unknown = await store.set("nope", true, null);
    expect(!unknown.ok && unknown.error.code).toBe("not_found");
    const proto = await store.set("__proto__", true, null);
    expect(!proto.ok && proto.error.code).toBe("not_found");
  });

  it("audits personal values hashed", async () => {
    const { registry, contact } = makeRegistry();
    const store = new SettingsStore(ctx({ env: { ...env, TOKEN_HASH_KEY: "k" } }), registry);
    expect((await store.set(contact, "owner@example.com", "01HZOWNER")).ok).toBe(true);
    expect(await store.get(contact)).toBe("owner@example.com");
    const [row] = await auditRows(contact);
    expect(row?.metadata).not.toContain("owner@example.com");
    expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({
      new: expect.stringMatching(/^value:[0-9a-z]{26}$/) as string,
    });
  });

  it("caches per isolate for the TTL and falls back to the default for an incompatible stored value", async () => {
    const { registry, flag } = makeRegistry();
    let now = Date.now();
    const store = new SettingsStore(ctx({ now: () => now }), registry);
    expect(await store.get(flag)).toBe(true);

    // Another isolate (here: a direct write) changes the value; this isolate sees it after the TTL.
    await env.DB.prepare("UPDATE installation SET settings = json_set(settings, ?, json('false')) WHERE id = 1")
      .bind(`$.${flag}`)
      .run();
    expect(await store.get(flag)).toBe(true);
    now += SETTINGS_CACHE_TTL_MS + 1;
    expect(await store.get(flag)).toBe(false);

    await env.DB.prepare("UPDATE installation SET settings = json_set(settings, ?, 'yes please') WHERE id = 1")
      .bind(`$.${flag}`)
      .run();
    clearSettingsCache(env.DB);
    expect(await store.get(flag)).toBe(true);
  });

  // Last: it rewrites the shared column (and discards other tests' keys, which is the documented behaviour).
  it("repairs a malformed settings column on the next write, and audits the repair", async () => {
    const { registry, flag, limit } = makeRegistry();
    await env.DB.prepare("UPDATE installation SET settings = 'not json' WHERE id = 1").run();
    clearSettingsCache(env.DB);
    const store = new SettingsStore(ctx(), registry);
    expect(await store.get(flag)).toBe(true);
    expect((await store.set(flag, false, "01HZADMIN")).ok).toBe(true);
    expect(await store.get(flag)).toBe(false);
    expect(await store.get(limit)).toBe(1000);
    const rows = await auditRows(flag);
    expect(JSON.parse(rows[rows.length - 1]?.metadata ?? "{}")).toEqual({ old: true, new: false, repaired: true });
  });
});
