import { apiError, err, ok, validationError, type ApiError, type Result } from "@officebox/shared";
import { z } from "zod";
import { auditStatement, hashPersonal } from "./audit";
import type { CoreContext } from "./context";
import { Database, expectOk } from "./db";

/**
 * Installation settings store (Platform §7).
 *
 * - **Typed keys.** Every key is declared once with `defineSetting`: a Zod schema, a default, who may
 *   change it and its audit action. Unknown keys can't be read or written.
 * - **Storage:** the `installation.settings` JSON column (TDD §6.1). Writes use `json_set` on one key,
 *   so concurrent changes to different keys don't overwrite each other. The installation row is
 *   created by first-run setup (M1); until then reads return defaults and writes return `unavailable`.
 * - **Tolerant reads (expand/contract):** a stored value that no longer matches its schema (written by
 *   a newer or older release) reads as the default and is logged.
 * - **Audit on change:** every change writes the key's audit action with old and new values, in the
 *   same D1 batch as the write. Personal values are stored hashed.
 * - **Cache:** per isolate, for at most 30 seconds **(default)**, as Platform §7 allows. A write in
 *   this isolate clears it; other isolates catch up within the TTL.
 *
 * Permission checks (`changeableBy`) are enforced by the admin settings route through the permission
 * engine (M1), not here.
 */

export type SettingRole = "admin" | "owner";

export interface SettingDefinition<T> {
  key: string;
  schema: z.ZodType<T>;
  default: T;
  changeableBy: SettingRole;
  /** Audit action written on change (Platform §7 column "Audit event"). */
  auditAction: string;
  /** Values are personal data (for example email addresses): audited hashed. */
  personal?: boolean;
}

export const SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export function defineSetting<T>(definition: SettingDefinition<T>): SettingDefinition<T> {
  if (!SETTING_KEY_PATTERN.test(definition.key)) throw new Error(`Invalid setting key: ${definition.key}`);
  if (!definition.schema.safeParse(definition.default).success) {
    throw new Error(`Default for ${definition.key} doesn't match its schema`);
  }
  return definition;
}

/** A registry maps each key to its definition. Keys must equal their definition's `key`. */
export type SettingsRegistry = Record<string, SettingDefinition<unknown>>;

/**
 * The installation's settings. M0 starts with two Platform §7 keys; each later milestone adds the keys
 * it uses, with their Platform §7 defaults and audit events.
 */
export const SETTINGS = {
  welcome_post_enabled: defineSetting({
    key: "welcome_post_enabled",
    schema: z.boolean(),
    default: true,
    changeableBy: "admin",
    auditAction: "settings.welcome_post",
  }),
  upload_max_bytes: defineSetting({
    key: "upload_max_bytes",
    schema: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 4),
    default: 2 * 1024 ** 3,
    changeableBy: "admin",
    auditAction: "settings.upload_limit",
  }),
} satisfies SettingsRegistry;

export type SettingKey<R extends SettingsRegistry> = keyof R & string;
export type SettingValue<R extends SettingsRegistry, K extends SettingKey<R>> =
  R[K] extends SettingDefinition<infer T> ? T : never;

export interface SettingEntry {
  key: string;
  value: unknown;
  isDefault: boolean;
  changeableBy: SettingRole;
}

export const SETTINGS_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  stored: Record<string, unknown>;
  /** Whether the installation row exists (setup has run). */
  installed: boolean;
  expiresAt: number;
}

// Per isolate, per D1 binding (tests use one binding; production has one installation).
const cache = new WeakMap<D1Database, CacheEntry>();

export class SettingsStore<R extends SettingsRegistry> {
  constructor(
    private readonly ctx: CoreContext,
    private readonly registry: R,
  ) {}

  private async load(): Promise<CacheEntry> {
    const now = this.ctx.now();
    const hit = cache.get(this.ctx.env.DB);
    if (hit && hit.expiresAt > now) return hit;
    const row = expectOk(
      await new Database(this.ctx.env.DB).first<{ settings: string }>("SELECT settings FROM installation WHERE id = 1"),
    );
    let stored: Record<string, unknown> = {};
    if (row) {
      try {
        const parsed: unknown = JSON.parse(row.settings);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
      } catch {
        this.ctx.log.error("installation.settings is not valid JSON; using defaults");
      }
    }
    const entry = { stored, installed: row !== null, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    cache.set(this.ctx.env.DB, entry);
    return entry;
  }

  private async stored(): Promise<Record<string, unknown>> {
    return (await this.load()).stored;
  }

  private resolve(definition: SettingDefinition<unknown>, stored: Record<string, unknown>): SettingEntry {
    const base = { key: definition.key, changeableBy: definition.changeableBy };
    if (!(definition.key in stored)) return { ...base, value: definition.default, isDefault: true };
    const parsed = definition.schema.safeParse(stored[definition.key]);
    if (!parsed.success) {
      this.ctx.log.warn("stored setting doesn't match its schema; using the default", { key: definition.key });
      return { ...base, value: definition.default, isDefault: true };
    }
    return { ...base, value: parsed.data, isDefault: false };
  }

  async get<K extends SettingKey<R>>(key: K): Promise<SettingValue<R, K>> {
    const definition = this.registry[key];
    if (!definition) throw new Error(`Unknown setting: ${key}`);
    return this.resolve(definition, await this.stored()).value as SettingValue<R, K>;
  }

  async list(): Promise<SettingEntry[]> {
    const stored = await this.stored();
    return Object.values(this.registry).map((definition) => this.resolve(definition, stored));
  }

  /**
   * Validates and stores a value, auditing the change. Untyped input (for example a PATCH body) is
   * validated against the key's schema; a value equal to the current one is a no-op without audit.
   */
  async set(key: string, value: unknown, actor: string | null): Promise<Result<SettingEntry, ApiError>> {
    const definition = Object.hasOwn(this.registry, key) ? this.registry[key] : undefined;
    if (!definition) return err(apiError("not_found", "No such setting."));
    const parsed = definition.schema.safeParse(value);
    if (!parsed.success) return err(validationError(parsed.error, "The setting value is not valid."));

    // Read fresh, not from the cache, so the audited old value is current.
    cache.delete(this.ctx.env.DB);
    const current = await this.load();
    if (!current.installed) return err(apiError("unavailable", "Settings can be changed once setup is complete."));
    const before = this.resolve(definition, current.stored);
    const next = parsed.data;
    if (!before.isDefault && JSON.stringify(before.value) === JSON.stringify(next)) return ok(before);

    const auditValue = async (v: unknown): Promise<unknown> =>
      definition.personal ? await hashPersonal(this.ctx.env, "value", JSON.stringify(v)) : v;
    const db = new Database(this.ctx.env.DB);
    // The key is checked against SETTING_KEY_PATTERN by defineSetting, so it is safe in the JSON path.
    const update = db.statement(
      `UPDATE installation SET settings = json_set(settings, '$.${definition.key}', json(?)) WHERE id = 1`,
      JSON.stringify(next),
    );
    const entry = await auditStatement(this.ctx, {
      action: definition.auditAction,
      actor,
      target: { type: "setting", id: definition.key },
      metadata: { old: await auditValue(before.value), new: await auditValue(next) },
    });
    expectOk(await db.batch([update, entry]));
    cache.delete(this.ctx.env.DB);
    return ok({ key: definition.key, value: next, isDefault: false, changeableBy: definition.changeableBy });
  }
}

/** Clears this isolate's settings cache (tests, and after a restore). */
export function clearSettingsCache(db: D1Database): void {
  cache.delete(db);
}
