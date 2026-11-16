import type { Env } from "../env";
import type { CoreContext } from "./context";
import { Database } from "./db";
import { ulid } from "./ids";
import { tokenHashKeyOrNull } from "./keys";
import { rootLogger } from "./log";
import { collectEmails, redact, REDACT_DEFAULTS, redactString, type Redacted } from "./redact";

/**
 * Audit-log writer (AGENTS §4.1: administrative and destructive actions write to `audit_log`).
 *
 * Metadata is sanitised before it is stored (Platform §3.1, §7):
 * - secret-named keys and token-like strings become `[redacted]`
 * - email addresses become `email:<hash>`, an HMAC keyed with `TOKEN_HASH_KEY`, so the same address
 *   always gives the same value without being readable; the Worker secret when set, otherwise the
 *   key the Worker generated (M1b-1); `[email]` when neither can be had
 * - metadata over 8 KB once serialised is replaced with `{ "truncated": true }`.
 *
 * Callers must still never pass message or document content, passwords or names.
 */

export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_METADATA_BYTES = 8 * 1024;

export interface AuditEntry {
  /** Dotted action name, for example `settings.welcome_post` (Platform §7 audit events). */
  action: string;
  /** User ID of the actor; `null` for the system (cron jobs, automatic actions). */
  actor: string | null;
  target?: { type: string; id: string } | null;
  metadata?: Record<string, unknown>;
}

const encoder = new TextEncoder();

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * HMAC-SHA-256, first 128 bits, as 26 lower-case base32 characters. Base32 rather than hex so the
 * pseudonym isn't itself redacted as a token-like hex run.
 */
async function hmacBase32(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of sig.slice(0, 16)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((acc >>> (bits - 5)) & 31);
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32.charAt((acc << (5 - bits)) & 31);
  return out;
}

/**
 * The env audit pseudonyms need: `TOKEN_HASH_KEY`, or, when that secret isn't set, the SystemObject
 * that holds the key the Worker generated (M1b-1, Platform §16).
 */
export type AuditKeyEnv = Pick<Env, "TOKEN_HASH_KEY"> & Partial<Pick<Env, "SYSTEM">>;

/** Pseudonymises a personal value for storage, or masks it when no hash key can be had. */
export async function hashPersonal(env: AuditKeyEnv, kind: string, value: string): Promise<string> {
  const key = await tokenHashKeyOrNull(env, rootLogger);
  if (!key) return `[${kind}]`;
  return `${kind}:${await hmacBase32(key, `audit:${kind}:${value.trim().toLowerCase()}`)}`;
}

/** Returns sanitised metadata as JSON text, or null when there is none. */
export async function sanitiseMetadata(
  env: AuditKeyEnv,
  metadata: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  const hashes = new Map<string, string>();
  for (const email of collectEmails(metadata)) {
    hashes.set(email, await hashPersonal(env, "email", email));
  }
  const clean: Redacted = redact(metadata, {
    email: (address) => hashes.get(address) ?? "[email]",
    maxDepth: REDACT_DEFAULTS.maxDepth,
    maxString: 500,
  });
  const json = JSON.stringify(clean);
  return encoder.encode(json).byteLength > MAX_METADATA_BYTES ? JSON.stringify({ truncated: true }) : json;
}

export interface AuditStatementOptions {
  /**
   * Write the entry only if the statement just before it in the same batch changed a row (SQLite
   * `changes()`), so a guarded update that matched nothing leaves no audit entry.
   */
  onlyIfPreviousChanged?: boolean;
}

/** Target type and ID are IDs by convention; they are still redacted in case one carries an email. */
async function sanitiseTarget(env: AuditKeyEnv, value: string | undefined): Promise<string | null> {
  if (value === undefined) return null;
  const hashes = new Map<string, string>();
  for (const email of collectEmails(value)) hashes.set(email, await hashPersonal(env, "email", email));
  return redactString(value, { email: (a) => hashes.get(a) ?? "[email]", maxString: 200 });
}

/**
 * Builds the INSERT for an audit entry without running it, so a caller can put it in the same D1
 * batch as the change it records (the entry and the change commit together).
 */
export async function auditStatement(
  ctx: CoreContext,
  entry: AuditEntry,
  options: AuditStatementOptions = {},
): Promise<D1PreparedStatement> {
  if (!AUDIT_ACTION_PATTERN.test(entry.action)) {
    throw new Error(`Invalid audit action: ${entry.action}`);
  }
  const metadata = await sanitiseMetadata(ctx.env, entry.metadata);
  const values = [
    ulid(),
    entry.actor,
    entry.action,
    await sanitiseTarget(ctx.env, entry.target?.type),
    await sanitiseTarget(ctx.env, entry.target?.id),
    metadata,
    ctx.now(),
  ];
  const columns = "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, metadata, created_at)";
  const sql = options.onlyIfPreviousChanged
    ? `${columns} SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`
    : `${columns} VALUES (?, ?, ?, ?, ?, ?, ?)`;
  return new Database(ctx.env.DB).statement(sql, ...values);
}

/** Writes an audit entry on its own. A failure to write is a real failure and throws. */
export async function audit(ctx: CoreContext, entry: AuditEntry): Promise<void> {
  await (await auditStatement(ctx, entry)).run();
}
