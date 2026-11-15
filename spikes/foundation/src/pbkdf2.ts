// WebCrypto-only password hashing: PBKDF2-SHA256 and the HMAC-pepper fallback (Identity §4.4 / TDD §8.1).
// No dependencies; this is the module the bundle-size script measures for the PBKDF2 candidates.
const enc = new TextEncoder();

export type HashResult =
  | { ok: true; hash: string; ms: number }
  | { ok: false; error: string; name: string; ms: number };

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "");
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function timed(fn: () => Promise<string>): Promise<HashResult> {
  const t0 = performance.now();
  try {
    const hash = await fn();
    return { ok: true, hash, ms: performance.now() - t0 };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.message, name: err.name, ms: performance.now() - t0 };
  }
}

// ---- PBKDF2-SHA256 (WebCrypto) ----

export async function pbkdf2Raw(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export function pbkdf2(password: string, iterations: number, salt = crypto.getRandomValues(new Uint8Array(16))) {
  return timed(async () => `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await pbkdf2Raw(enc.encode(password), salt, iterations))}`);
}

// ---- Fallback A: HMAC pepper (Worker secret) + PBKDF2 100k ----
//
// Format: pbkdf2-sha256-hmac$<pepperId>$100000$<salt>$<hash>
//   input to PBKDF2 = HMAC-SHA256(PEPPER_<pepperId>, password)
// Each pepper is at least 32 random bytes (e.g. `openssl rand -base64 32`), held only in Worker secrets.
// Rotation: add PEPPER_<n+1>, write new hashes with it, re-hash at next sign-in; after a deadline, accounts still
// on a retired pepper must reset their password, and only then is the old secret deleted.
// A stolen D1 dump without the Worker secret cannot be brute-forced offline at all; with the secret the cost is
// the same as plain PBKDF2 100k.

/** Current hashing policy: what new hashes use, and what the dummy derivation costs. */
export const POLICY = { iterations: 100_000 } as const;
/** Stored iteration counts outside this range are refused, so a tampered row can't make verify burn CPU. */
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 1_000_000;
export const MIN_PEPPER_BYTES = 32;

async function pepperInput(pepper: string, password: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(password)));
}

export function pepperedPbkdf2(password: string, pepper: string, pepperId = "1", iterations: number = POLICY.iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return timed(async () => {
    if (enc.encode(pepper).length < MIN_PEPPER_BYTES) throw new Error(`pepper must be at least ${MIN_PEPPER_BYTES} bytes`);
    const out = await pbkdf2Raw(await pepperInput(pepper, password), salt, iterations);
    return `pbkdf2-sha256-hmac$${pepperId}$${iterations}$${b64(salt)}$${b64(out)}`;
  });
}

export type Peppers = Readonly<Record<string, string>>;

/** Own, string-valued, long-enough pepper only: ids like "__proto__" or "constructor" never resolve. */
function lookupPepper(peppers: Peppers, id: string): string | null {
  if (!Object.hasOwn(peppers, id)) return null;
  const v: unknown = peppers[id];
  return typeof v === "string" && enc.encode(v).length >= MIN_PEPPER_BYTES ? v : null;
}

function safeFromB64(s: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (!s) return null;
  try {
    return fromB64(s);
  } catch {
    return null; // atob throws on malformed input
  }
}

/**
 * Verifies a `pbkdf2-sha256-hmac$…` hash. Never throws. Every refusal before the real derivation (malformed row,
 * out-of-range iterations, unknown, retired or too-short pepper) runs the dummy derivation instead, so failure
 * paths cost the same as a real check.
 */
export async function verifyPeppered(stored: string, password: string, peppers: Peppers): Promise<boolean> {
  const parts = stored.split("$");
  const [scheme, pepperId, iter, salt, hash] = parts;
  const iterations = iter !== undefined && /^\d+$/.test(iter) ? Number(iter) : Number.NaN;
  const saltBytes = safeFromB64(salt);
  const hashBytes = safeFromB64(hash);
  const pepper = pepperId ? lookupPepper(peppers, pepperId) : null;
  const wellFormed =
    parts.length === 5 &&
    scheme === "pbkdf2-sha256-hmac" &&
    Number.isInteger(iterations) &&
    iterations >= MIN_ITERATIONS &&
    iterations <= MAX_ITERATIONS &&
    saltBytes?.length === 16 &&
    hashBytes?.length === 32;
  if (!wellFormed || !pepper || !saltBytes || !hashBytes) return dummyVerify(password);
  const out = await pbkdf2Raw(await pepperInput(pepper, password), saltBytes, iterations);
  return timingSafeEqual(out, hashBytes);
}

const DUMMY_PEPPER = "dummy-pepper-for-timing-parity-only-0123456789";

/**
 * Sign-in for an email with no account (or a passkey-only account), and verify's own refusal paths, must cost the
 * same as a real check, or the response time reveals which emails exist. Runs the full HMAC + PBKDF2 derivation
 * at the current policy's iteration count and returns false.
 */
export async function dummyVerify(password: string, iterations: number = POLICY.iterations): Promise<false> {
  await pbkdf2Raw(await pepperInput(DUMMY_PEPPER, password), new Uint8Array(16), iterations);
  return false;
}
