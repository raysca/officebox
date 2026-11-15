import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
    expect(hashed.a).toMatch(/^email:[0-9a-f]{32}$/);
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
});

describe("settings store", () => {
  const registry = {
    ...SETTINGS,
    contact_email: defineSetting({
      key: "contact_email",
      schema: z.email().nullable(),
      default: null,
      changeableBy: "owner",
      auditAction: "settings.contact",
      personal: true,
    }),
  } satisfies SettingsRegistry;

  it("refuses an invalid definition", () => {
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
  });

  // Runs first: the installation row doesn't exist until "setup" below.
  it("reads defaults and refuses writes before setup", async () => {
    clearSettingsCache(env.DB);
    const store = new SettingsStore(ctx(), registry);
    expect(await store.get("welcome_post_enabled")).toBe(true);
    const result = await store.set("welcome_post_enabled", false, "01HZADMIN");
    expect(!result.ok && result.error.code).toBe("unavailable");
  });

  it("gets, sets and lists typed values, auditing each change", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO installation (id, installation_id, name, settings) VALUES (1, 'inst', 'Test', '{}')",
    ).run();
    clearSettingsCache(env.DB);
    const store = new SettingsStore(ctx(), registry);

    expect(await store.get("upload_max_bytes")).toBe(2 * 1024 ** 3);
    const set = await store.set("upload_max_bytes", 1024, "01HZADMIN");
    expect(set).toEqual({
      ok: true,
      value: { key: "upload_max_bytes", value: 1024, isDefault: false, changeableBy: "admin" },
    });
    expect(await store.get("upload_max_bytes")).toBe(1024);

    // Setting the same value again is a no-op without a second audit entry.
    await store.set("upload_max_bytes", 1024, "01HZADMIN");
    expect(await auditRows("upload_max_bytes")).toEqual([
      {
        actor_id: "01HZADMIN",
        action: "settings.upload_limit",
        target_type: "setting",
        target_id: "upload_max_bytes",
        metadata: JSON.stringify({ old: 2 * 1024 ** 3, new: 1024 }),
      },
    ]);

    const list = await store.list();
    expect(list.find((e) => e.key === "upload_max_bytes")).toMatchObject({ value: 1024, isDefault: false });
    expect(list.find((e) => e.key === "welcome_post_enabled")).toMatchObject({ value: true, isDefault: true });
  });

  it("validates values and refuses unknown keys", async () => {
    const store = new SettingsStore(ctx(), registry);
    const invalid = await store.set("upload_max_bytes", -5, null);
    expect(!invalid.ok && invalid.error.code).toBe("validation_failed");
    const unknown = await store.set("nope", true, null);
    expect(!unknown.ok && unknown.error.code).toBe("not_found");
    const proto = await store.set("__proto__", true, null);
    expect(!proto.ok && proto.error.code).toBe("not_found");
  });

  it("audits personal values hashed", async () => {
    const store = new SettingsStore(ctx({ env: { ...env, TOKEN_HASH_KEY: "k" } }), registry);
    expect((await store.set("contact_email", "owner@example.com", "01HZOWNER")).ok).toBe(true);
    expect(await store.get("contact_email")).toBe("owner@example.com");
    const [row] = await auditRows("contact_email");
    expect(row?.metadata).not.toContain("owner@example.com");
    expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({
      new: expect.stringMatching(/^value:[0-9a-f]{32}$/) as string,
    });
  });

  it("caches per isolate for the TTL and falls back to the default for an incompatible stored value", async () => {
    let now = Date.now();
    const store = new SettingsStore(ctx({ now: () => now }), registry);
    clearSettingsCache(env.DB);
    expect(await store.get("welcome_post_enabled")).toBe(true);

    // Another isolate (here: a direct write) changes the value; this isolate sees it after the TTL.
    await env.DB.prepare(
      "UPDATE installation SET settings = json_set(settings, '$.welcome_post_enabled', json('false')) WHERE id = 1",
    ).run();
    expect(await store.get("welcome_post_enabled")).toBe(true);
    now += SETTINGS_CACHE_TTL_MS + 1;
    expect(await store.get("welcome_post_enabled")).toBe(false);

    await env.DB.prepare(
      "UPDATE installation SET settings = json_set(settings, '$.welcome_post_enabled', 'yes please') WHERE id = 1",
    ).run();
    clearSettingsCache(env.DB);
    expect(await store.get("welcome_post_enabled")).toBe(true);
  });
});
