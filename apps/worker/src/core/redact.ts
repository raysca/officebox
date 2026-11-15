/**
 * Redaction of secrets and personal data from values that leave the request: log lines (`log.ts`)
 * and audit metadata (`audit.ts`). Platform §3.1 and §7: audit entries never store raw passwords or
 * tokens, and personal values such as email addresses are stored hashed.
 *
 * Rules, applied recursively:
 * - a property whose **key** names a secret (password, token, secret, cookie, authorization, API key,
 *   credential, private key, signature) has its value replaced with `[redacted]`
 * - **email addresses** inside any string are replaced by the caller's `email` function
 * - **token-like strings** are replaced with `[redacted]`: JWTs, `Bearer …` values, and runs of 32 or
 *   more base64 characters that mix upper case, lower case and digits (hex IDs and ULIDs are kept)
 * - depth, array length and string length are capped so a huge value can't flood a log line.
 */

export const REDACTED = "[redacted]";

const SENSITIVE_KEY =
  /pass(word|wd|phrase)|secret|token|authori[sz]ation|cookie|api[-_]?key|credential|private[-_]?key|signature/i;
export const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const OPAQUE_RUN = /[A-Za-z0-9_\-+/=]{32,}/g;

export interface RedactOptions {
  /** Replacement for an email address found in a string. */
  email: (address: string) => string;
  maxDepth?: number;
  maxArray?: number;
  maxString?: number;
}

/** JSON-compatible output of `redact`. */
export type Redacted = string | number | boolean | null | Redacted[] | { [key: string]: Redacted };

function looksLikeSecret(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/** Redacts emails and token-like substrings in one string. */
export function redactString(value: string, options: RedactOptions): string {
  const maxString = options.maxString ?? 2000;
  let out = value
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(EMAIL_PATTERN, (address) => options.email(address))
    .replace(OPAQUE_RUN, (run) => (looksLikeSecret(run) ? REDACTED : run));
  if (out.length > maxString) out = `${out.slice(0, maxString)}…`;
  return out;
}

/** Returns a JSON-compatible copy of `value` with secrets and personal data removed. */
export function redact(value: unknown, options: RedactOptions): Redacted {
  const maxDepth = options.maxDepth ?? 6;
  const maxArray = options.maxArray ?? 50;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): Redacted => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return redactString(v, options);
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object") return `[${typeof v}]`;
    if (seen.has(v)) return "[circular]";
    if (depth >= maxDepth) return "[truncated]";
    seen.add(v);
    if (v instanceof Error) {
      return {
        name: v.name,
        message: redactString(v.message, options),
        ...(v.stack ? { stack: redactString(v.stack, { ...options, maxString: 4000 }) } : {}),
      };
    }
    if (Array.isArray(v)) {
      const items = v.slice(0, maxArray).map((item) => walk(item, depth + 1));
      if (v.length > maxArray) items.push(`[${v.length - maxArray} more]`);
      return items;
    }
    const out: { [key: string]: Redacted } = {};
    for (const [key, item] of Object.entries(v)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(item, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
}

/** Finds every email address in `value` (strings, arrays and object values, not keys). */
export function collectEmails(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || value === null || value === undefined) return found;
  if (typeof value === "string") {
    for (const match of value.matchAll(EMAIL_PATTERN)) found.add(match[0]);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEmails(item, found, depth + 1);
  } else if (typeof value === "object") {
    for (const item of Object.values(value)) collectEmails(item, found, depth + 1);
  }
  return found;
}
