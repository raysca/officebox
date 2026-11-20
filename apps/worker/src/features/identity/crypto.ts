/**
 * Small WebCrypto helpers for identity: base64url, HMAC-SHA-256, SHA-256, random tokens and
 * constant-time comparison. No dependencies (AGENTS §4.4 prefers the platform), and no Workers-only
 * APIs, so the Node timing tests can import it.
 */

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64url (or standard base64, padded or not). Null for anything malformed. */
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_\-+/]*={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** `n` random bytes as base64url: 32 bytes give 43 characters (TDD §8.1 tokens are 32 random bytes). */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

/** Imported HMAC keys are cached per isolate: importing costs more than signing a short value. */
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    // Bounded: an installation has a handful of secrets; tests make more.
    if (hmacKeys.size > 64) hmacKeys.clear();
    hmacKeys.set(secret, key);
  }
  return key;
}

export async function hmacSha256(secret: string, data: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), bytes));
}

export async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

/**
 * Constant-time equality of two byte strings. The loop always runs over the longer input, so the time
 * depends only on the lengths, which are public (fixed-size digests everywhere here).
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Byte length of a secret as UTF-8, for the "at least 32 bytes" rules (Platform §16). */
export function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** How our tokens are stored (Identity §5): HMAC(TOKEN_HASH_KEY, token), base64url. */
export async function tokenHash(key: string, token: string): Promise<string> {
  return base64url(await hmacSha256(key, token));
}

/**
 * How a used `RECOVERY_TOKEN` value is recorded: `hash` = base64url(SHA-256(value)), what new rows use;
 * `legacy` = HMAC(TOKEN_HASH_KEY, value), what rows written before M1c's review fix would hold.
 */
export async function recoveryTokenHashes(
  key: string | null,
  secret: string,
): Promise<{ hash: string; legacy: string }> {
  const hash = `sha256:${base64url(await sha256(secret))}`;
  return { hash, legacy: key ? await tokenHash(key, secret) : hash };
}
