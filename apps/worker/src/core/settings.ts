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
  /** The column held something other than a JSON object; the next write repairs it. */
  malformed: boolean;
  /** Whether the installation row exists (setup has run). */
  installed: boolean;
  expiresAt: number;
}

// Per isolate, per D1 binding (tests use one binding; production has one installation).
const cache = new WeakMap<D1Database, CacheEntry>();
// Bumped on every invalidation, so a read that started before a write can't repopulate the cache
// with the value from before the write.
const generations = new WeakMap<D1Database, number>();

function invalidate(db: D1Database): void {
  cache.delete(db);
  generations.set(db, (generations.get(db) ?? 0) + 1);
}

/** Attempts at a guarded write before reporting a conflict (another writer changed the key between). */
const WRITE_ATTEMPTS = 2;

export class SettingsStore<R extends SettingsRegistry> {
  constructor(
    private readonly ctx: CoreContext,
    private readonly registry: R,
  ) {
    for (const [key, definition] of Object.entries(registry)) {
      if (!SETTING_KEY_PATTERN.test(key) || key !== definition.key) {
        throw new Error(`Settings registry entry ${key} must be a valid key equal to its definition's key`);
      }
    }
  }

  private async load(fresh = false): Promise<CacheEntry> {
    const db = this.ctx.env.DB;
    const now = this.ctx.now();
    const hit = cache.get(db);
    if (!fresh && hit && hit.expiresAt > now) return hit;
    const generation = generations.get(db) ?? 0;
    const row = expectOk(
      await new Database(db).first<{ settings: string }>("SELECT settings FROM installation WHERE id = 1"),
    );
    let stored: Record<string, unknown> = {};
    let malformed = false;
    if (row) {
      try {
        const parsed: unknown = JSON.parse(row.settings);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
        else malformed = true;
      } catch {
        malformed = true;
      }
      if (malformed) this.ctx.log.error("installation.settings is not a JSON object; using defaults until repaired");
    }
    const entry = { stored, malformed, installed: row !== null, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    if ((generations.get(db) ?? 0) === generation) cache.set(db, entry);
    return entry;
  }

  private async stored(): Promise<Record<string, unknown>> {
    return (await this.load()).stored;
  }

  private resolve(definition: SettingDefinition<unknown>, stored: Record<string, unknown>): SettingEntry {
    const base = { key: definition.key, changeableBy: definition.changeableBy };
    if (!Object.hasOwn(stored, definition.key)) return { ...base, value: definition.default, isDefault: true };
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
   *
   * The write is guarded on the value it read (compare-and-set), so the audited `old` value is exact
   * even with concurrent writers; if another writer got in between, it re-reads and tries once more,
   * then returns `conflict`. Both sides of the comparison go through SQLite's `json_extract`, so
   * objects and arrays compare in SQLite's own canonical JSON text, not JavaScript's.
   *
   * A malformed column is replaced with a fresh object holding only this key, and the audit entry
   * says so (`repaired: true`). **Any other settings in the malformed column are discarded**: they
   * couldn't be read, so they were already in effect as their defaults.
   */
  async set(key: string, value: unknown, actor: string | null): Promise<Result<SettingEntry, ApiError>> {
    const definition = Object.hasOwn(this.registry, key) ? this.registry[key] : undefined;
    if (!definition) return err(apiError("not_found", "No such setting."));
    const parsed = definition.schema.safeParse(value);
    if (!parsed.success) return err(validationError(parsed.error, "The setting value is not valid."));
    const next = parsed.data;
    const db = new Database(this.ctx.env.DB);
    const auditValue = async (v: unknown): Promise<unknown> =>
      definition.personal ? await hashPersonal(this.ctx.env, "value", JSON.stringify(v)) : v;
    // Bound as a parameter, never interpolated; the key is also checked against SETTING_KEY_PATTERN.
    const path = `$.${definition.key}`;

    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      invalidate(this.ctx.env.DB);
      const current = await this.load(true);
      if (!current.installed) return err(apiError("unavailable", "Settings can be changed once setup is complete."));
      const before = this.resolve(definition, current.stored);
      if (!current.malformed && !before.isDefault && JSON.stringify(before.value) === JSON.stringify(next)) {
        return ok(before);
      }

      const update = current.malformed
        ? db.statement(
            `UPDATE installation SET settings = json_set('{}', ?, json(?))
             WHERE id = 1 AND (json_valid(settings) = 0 OR json_type(settings) <> 'object')`,
            path,
            JSON.stringify(next),
          )
        : db.statement(
            `UPDATE installation SET settings = json_set(settings, ?, json(?))
             WHERE id = 1 AND json_extract(settings, ?) IS json_extract(?, '$')`,
            path,
            JSON.stringify(next),
            path,
            JSON.stringify(current.stored[definition.key] ?? null),
          );
      const entry = await auditStatement(
        this.ctx,
        {
          action: definition.auditAction,
          actor,
          target: { type: "setting", id: definition.key },
          metadata: {
            old: await auditValue(before.value),
            new: await auditValue(next),
            ...(current.malformed ? { repaired: true } : {}),
          },
        },
        { onlyIfPreviousChanged: true },
      );
      const [result] = expectOk(await db.batchRun([update, entry]));
      invalidate(this.ctx.env.DB);
      if ((result?.changes ?? 0) > 0) {
        return ok({ key: definition.key, value: next, isDefault: false, changeableBy: definition.changeableBy });
      }
      this.ctx.log.info("setting changed concurrently; retrying", { key: definition.key, attempt });
    }
    return err(apiError("conflict", "The setting was changed at the same time. Try again."));
  }
}

/** Clears this isolate's settings cache (tests, and after a restore). */
export function clearSettingsCache(db: D1Database): void {
  invalidate(db);
}
