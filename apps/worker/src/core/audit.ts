import type { Env } from "../env";
import type { CoreContext } from "./context";
import { Database } from "./db";
import { ulid } from "./ids";
import { collectEmails, redact, type Redacted } from "./redact";

/**
 * Audit-log writer (AGENTS §4.1: administrative and destructive actions write to `audit_log`).
 *
 * Metadata is sanitised before it is stored (Platform §3.1, §7):
 * - secret-named keys and token-like strings become `[redacted]`
 * - email addresses become `email:<hash>`, an HMAC keyed with `TOKEN_HASH_KEY`, so the same address
 *   always gives the same value without being readable; before that secret exists (M1) they become
 *   `[email]`
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

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pseudonymises a personal value for storage, or masks it when no hash key is configured yet. */
export async function hashPersonal(env: Pick<Env, "TOKEN_HASH_KEY">, kind: string, value: string): Promise<string> {
  if (!env.TOKEN_HASH_KEY) return `[${kind}]`;
  return `${kind}:${await hmacHex(env.TOKEN_HASH_KEY, `audit:${kind}:${value.trim().toLowerCase()}`)}`;
}

/** Returns sanitised metadata as JSON text, or null when there is none. */
export async function sanitiseMetadata(
  env: Pick<Env, "TOKEN_HASH_KEY">,
  metadata: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  const hashes = new Map<string, string>();
  for (const email of collectEmails(metadata)) {
    hashes.set(email, await hashPersonal(env, "email", email));
  }
  const clean: Redacted = redact(metadata, {
    email: (address) => hashes.get(address) ?? "[email]",
    maxDepth: 5,
    maxString: 500,
  });
  const json = JSON.stringify(clean);
  return encoder.encode(json).byteLength > MAX_METADATA_BYTES ? JSON.stringify({ truncated: true }) : json;
}

/**
 * Builds the INSERT for an audit entry without running it, so a caller can put it in the same D1
 * batch as the change it records (the entry and the change commit together).
 */
export async function auditStatement(ctx: CoreContext, entry: AuditEntry): Promise<D1PreparedStatement> {
  if (!AUDIT_ACTION_PATTERN.test(entry.action)) {
    throw new Error(`Invalid audit action: ${entry.action}`);
  }
  const metadata = await sanitiseMetadata(ctx.env, entry.metadata);
  return new Database(ctx.env.DB).statement(
    "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ulid(),
    entry.actor,
    entry.action,
    entry.target?.type ?? null,
    entry.target?.id ?? null,
    metadata,
    ctx.now(),
  );
}

/** Writes an audit entry on its own. A failure to write is a real failure and throws. */
export async function audit(ctx: CoreContext, entry: AuditEntry): Promise<void> {
  await (await auditStatement(ctx, entry)).run();
}
