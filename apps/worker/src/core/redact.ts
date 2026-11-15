/**
 * Redaction of secrets and personal data from values that leave the request: log lines (`log.ts`)
 * and audit metadata (`audit.ts`). Platform §3.1 and §7: audit entries never store raw passwords or
 * tokens, and personal values such as email addresses are stored hashed.
 *
 * Rules, applied recursively:
 * - a property whose **key** names a secret has its value replaced with `[redacted]` (see
 *   `isSensitiveKey`). Keys themselves are redacted like strings, so an email used as a key is masked.
 * - **email addresses** inside any string are replaced by the caller's `email` function
 * - **token-like strings** become `[redacted]`: JWTs, `Bearer …`/`Basic …` values, credential URL
 *   query parameters (`token`, `code`, `ticket`, `key`, `sig`, `signature`, …), runs of 32 or more
 *   base64 characters mixing upper case, lower case and digits (M1 tokens are base64url of 32 random
 *   bytes **(default)**), and runs of 32 or more hex digits. ULIDs (26 characters) are kept.
 * - depth, array length and string length are capped so a huge value can't flood a log line.
 *
 * **Cost is bounded.** Strings are cut to `maxString` (plus a small margin) before any pattern runs,
 * so whatever the input size, the patterns see at most about 2 KB. Most patterns are linear; the hex
 * and opaque-run patterns can backtrack quadratically on a crafted run, but only over that 2 KB, so a
 * hostile value costs well under a millisecond (checked in `test/node/redact-timing.test.ts`).
 */

export const REDACTED = "[redacted]";

/** Default caps, shared by logs and audit metadata. */
export const REDACT_DEFAULTS = { maxDepth: 6, maxArray: 50, maxString: 2000 } as const;

/** Key fragments that name a secret wherever they appear in the (lower-cased, punctuation-free) key. */
const SENSITIVE_FRAGMENT =
  /pass(word|wd|phrase)|secret|token|authori[sz]ation|cookie|credential|signature|apikey|privatekey|accesskey|signingkey|encryptionkey|jwt|bearer|csrf|xsrf|hmac|pepper|signing|encryption/;
/** Words that name a secret when they are a whole word of the key (`otpCode`, `mfa_otp`). */
const SENSITIVE_WORD = new Set(["otp", "pin", "sid", "jwt", "csrf", "bearer", "hmac", "pepper"]);
/** Ambiguous names that are only secret as the entire key (`code` yes, `errorCode` no). */
const SENSITIVE_EXACT = new Set(["key", "code", "session", "sessionid", "pin", "sid", "sig", "otp", "ticket"]);

/** Whether a property name names a secret. */
export function isSensitiveKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_EXACT.has(flat) || SENSITIVE_FRAGMENT.test(flat)) return true;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((w) => SENSITIVE_WORD.has(w));
}

// Bounded patterns: an email local part is at most 64 characters, a domain label at most 63, and at
// most 8 labels; runs are matched greedily without nested quantifiers.
export const EMAIL_PATTERN = /[A-Z0-9._%+-]{1,64}@(?:[A-Z0-9-]{1,63}\.){1,8}[A-Z]{2,24}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{5,8192}\.[A-Za-z0-9_-]{0,2048}/g;
const AUTH_SCHEME_PATTERN = /\b(bearer|basic)\s{1,8}[A-Za-z0-9._~+/=-]{8,}/gi;
const QUERY_SECRET_PATTERN =
  /([?&;](?:access_token|refresh_token|id_token|token|code|ticket|key|api_key|sig|signature|secret|password)=)[^&#\s"'<>]*/gi;
const OPAQUE_RUN = /[A-Za-z0-9_\-+/=]{32,}/g;
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g;
/** Characters kept beyond `maxString` before matching, so a token straddling the cut is still caught. */
const CUT_MARGIN = 256;

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
  const maxString = options.maxString ?? REDACT_DEFAULTS.maxString;
  const truncated = value.length > maxString;
  let out = truncated ? value.slice(0, maxString + CUT_MARGIN) : value;
  out = out
    .replace(JWT_PATTERN, REDACTED)
    .replace(AUTH_SCHEME_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(QUERY_SECRET_PATTERN, (_m, name: string) => `${name}${REDACTED}`)
    .replace(HEX_RUN, REDACTED)
    .replace(OPAQUE_RUN, (run) => (looksLikeSecret(run) ? REDACTED : run));
  // Last, so the replacement (for example an audit pseudonym) isn't itself matched as a token.
  if (out.includes("@")) out = out.replace(EMAIL_PATTERN, (address) => options.email(address));
  if (truncated || out.length > maxString) out = `${out.slice(0, maxString)}…`;
  return out;
}

/** Returns a JSON-compatible copy of `value` with secrets and personal data removed. */
export function redact(value: unknown, options: RedactOptions): Redacted {
  const maxDepth = options.maxDepth ?? REDACT_DEFAULTS.maxDepth;
  const maxArray = options.maxArray ?? REDACT_DEFAULTS.maxArray;
  // Objects on the current path: a repeat is a real cycle. Shared (non-cyclic) references are fine.
  const path = new Set<object>();

  const entries = (pairs: Iterable<[unknown, unknown]>, depth: number): { [key: string]: Redacted } => {
    const out: { [key: string]: Redacted } = {};
    let count = 0;
    for (const [rawKey, item] of pairs) {
      if (count++ >= maxArray * 4) {
        out["…"] = "[truncated]";
        break;
      }
      const key = String(rawKey);
      out[redactString(key, { ...options, maxString: 200 })] = isSensitiveKey(key) ? REDACTED : walk(item, depth + 1);
    }
    return out;
  };

  const walk = (v: unknown, depth: number): Redacted => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return redactString(v, options);
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object") return `[${typeof v}]`;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    if (path.has(v)) return "[circular]";
    if (depth >= maxDepth) return "[truncated]";
    path.add(v);
    try {
      if (v instanceof Error) {
        return {
          name: v.name,
          message: redactString(v.message, options),
          ...(v.stack ? { stack: redactString(v.stack, { ...options, maxString: 4000 }) } : {}),
        };
      }
      const list = Array.isArray(v) ? v : v instanceof Set ? [...v] : null;
      if (list) {
        const items = list.slice(0, maxArray).map((item) => walk(item, depth + 1));
        if (list.length > maxArray) items.push(`[${list.length - maxArray} more]`);
        return items;
      }
      if (v instanceof Map) return entries(v.entries(), depth);
      return entries(Object.entries(v), depth);
    } finally {
      path.delete(v);
    }
  };

  return walk(value, 0);
}

/** Finds every email address in `value` (keys, strings, arrays and object values). */
export function collectEmails(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > REDACT_DEFAULTS.maxDepth || value === null || value === undefined) return found;
  if (typeof value === "string") {
    const text = value.slice(0, REDACT_DEFAULTS.maxString + CUT_MARGIN);
    if (text.includes("@")) for (const match of text.matchAll(EMAIL_PATTERN)) found.add(match[0]);
  } else if (Array.isArray(value) || value instanceof Set) {
    for (const item of value) collectEmails(item, found, depth + 1);
  } else if (value instanceof Map) {
    for (const [k, item] of value) {
      collectEmails(String(k), found, depth + 1);
      collectEmails(item, found, depth + 1);
    }
  } else if (typeof value === "object") {
    for (const [k, item] of Object.entries(value)) {
      collectEmails(k, found, depth + 1);
      collectEmails(item, found, depth + 1);
    }
  }
  return found;
}
