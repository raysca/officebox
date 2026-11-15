import { base64url, byteLength, fromBase64url, hmacSha256, timingSafeEqual } from "./crypto";

/**
 * Password hashing (Identity §4.4, TDD §8.1): PBKDF2-HMAC-SHA256 at 100,000 iterations with a 16-byte
 * salt, over an HMAC-SHA256 pepper held in Worker secrets:
 *
 *   input  = HMAC-SHA256(PEPPER_<pepperId>, password)
 *   hash   = PBKDF2-SHA256(input, salt, iterations, 32 bytes)
 *   stored = pbkdf2-sha256-hmac$<pepperId>$<iterations>$<salt b64url>$<hash b64url>
 *
 * Production Workers cap PBKDF2 at 100,000 iterations (M0 foundation spike, confirmed in production).
 *
 * - **Pepper rotation:** new hashes use the highest-numbered `PEPPER_<n>`. A successful sign-in with
 *   an older pepper (or other iterations) reports `needsRehash`, and the caller re-hashes. Once a
 *   retired pepper's secret is deleted after its published deadline, hashes that still use it can't
 *   verify, so those accounts reset their password (or use a magic link or passkey).
 * - **No enumeration by timing:** verifying for an unknown account, a passkey-only account, a
 *   malformed row, an out-of-range iteration count or a missing pepper runs the same derivation
 *   against a dummy salt and pepper, then fails.
 * - **Bounds:** stored iteration counts outside 100,000–1,000,000 are refused before deriving, so a
 *   tampered row can't make verification burn CPU.
 * - **Never throws:** a derivation the runtime refuses (for example above its cap) is a failed match.
 *
 * Reference: spikes/foundation/src/pbkdf2.ts (not imported).
 */

export const HASH_SCHEME = "pbkdf2-sha256-hmac";
export const PASSWORD_ITERATIONS = 100_000;
export const MIN_STORED_ITERATIONS = 100_000;
export const MAX_STORED_ITERATIONS = 1_000_000;
export const MIN_PEPPER_BYTES = 32;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** Pepper secrets by id ("1" for `PEPPER_1`). */
export type Peppers = Readonly<Record<string, string>>;

/** The peppers to use and which one new hashes take. */
export interface PepperSet {
  peppers: Peppers;
  /** The highest-numbered usable pepper. */
  currentId: string;
}

/**
 * Reads `PEPPER_<n>` secrets from the environment. Only own string values of at least 32 bytes count;
 * shorter ones are reported in `invalid` so the caller can log them by name (never by value).
 */
export function peppersFromEnv(env: object): { set: PepperSet | null; invalid: string[] } {
  const peppers: Record<string, string> = {};
  const invalid: string[] = [];
  let current: number | null = null;
  for (const [name, value] of Object.entries(env)) {
    const match = /^PEPPER_([1-9]\d{0,5})$/.exec(name);
    if (!match?.[1] || value === undefined || value === "") continue;
    if (typeof value !== "string" || byteLength(value) < MIN_PEPPER_BYTES) {
      invalid.push(name);
      continue;
    }
    peppers[match[1]] = value;
    const id = Number(match[1]);
    if (current === null || id > current) current = id;
  }
  return { set: current === null ? null : { peppers, currentId: String(current) }, invalid };
}

/** Own, string-valued, long-enough pepper only: ids like "__proto__" never resolve. */
function lookupPepper(peppers: Peppers, id: string): string | null {
  if (!Object.hasOwn(peppers, id)) return null;
  const value: unknown = peppers[id];
  return typeof value === "string" && byteLength(value) >= MIN_PEPPER_BYTES ? value : null;
}

async function derive(
  pepper: string,
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const input = await hmacSha256(pepper, password);
  const key = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Hashes a new password with the current pepper and policy. */
export async function hashPassword(password: string, pepperSet: PepperSet): Promise<string> {
  const pepper = lookupPepper(pepperSet.peppers, pepperSet.currentId);
  if (!pepper) throw new Error("Current pepper is not usable");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pepper, password, salt, PASSWORD_ITERATIONS);
  return `${HASH_SCHEME}$${pepperSet.currentId}$${PASSWORD_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

const DUMMY_PEPPER = "officebox-dummy-pepper-for-timing-parity-only";
const DUMMY_SALT = new Uint8Array(SALT_BYTES);

/** The full derivation at the current policy, for paths that must cost the same as a real check. */
export async function dummyVerify(password: string): Promise<false> {
  try {
    await derive(DUMMY_PEPPER, password, DUMMY_SALT, PASSWORD_ITERATIONS);
  } catch {
    // Same as verify: a refused derivation is just a failed match.
  }
  return false;
}

export interface VerifyResult {
  valid: boolean;
  /** Valid, but hashed with an older pepper or other iterations: re-hash with the current policy. */
  needsRehash: boolean;
  /** The stored hash names a pepper that isn't configured (retired, or a restore without it). */
  unknownPepper: boolean;
}

interface ParsedHash {
  pepperId: string;
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
  hash: Uint8Array;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [scheme, pepperId, iter, salt, hash] = parts;
  if (scheme !== HASH_SCHEME || !pepperId || !iter || !/^\d{1,8}$/.test(iter)) return null;
  const iterations = Number(iter);
  if (iterations < MIN_STORED_ITERATIONS || iterations > MAX_STORED_ITERATIONS) return null;
  const saltBytes = salt ? fromBase64url(salt) : null;
  const hashBytes = hash ? fromBase64url(hash) : null;
  if (saltBytes?.length !== SALT_BYTES || hashBytes?.length !== HASH_BYTES) return null;
  return { pepperId, iterations, salt: saltBytes, hash: hashBytes };
}

/**
 * Verifies `password` against a stored hash, or against nothing (`null`: unknown or passkey-only
 * account), always costing one full derivation. Never throws.
 */
export async function verifyPassword(
  stored: string | null,
  password: string,
  pepperSet: PepperSet,
): Promise<VerifyResult> {
  const failed = (unknownPepper = false): VerifyResult => ({ valid: false, needsRehash: false, unknownPepper });
  const parsed = stored === null ? null : parseHash(stored);
  if (!parsed) {
    await dummyVerify(password);
    return failed();
  }
  const pepper = lookupPepper(pepperSet.peppers, parsed.pepperId);
  if (!pepper) {
    await dummyVerify(password);
    return failed(true);
  }
  let derived: Uint8Array;
  try {
    derived = await derive(pepper, password, parsed.salt, parsed.iterations);
  } catch {
    return failed();
  }
  const valid = timingSafeEqual(derived, parsed.hash);
  return {
    valid,
    needsRehash: valid && (parsed.pepperId !== pepperSet.currentId || parsed.iterations !== PASSWORD_ITERATIONS),
    unknownPepper: false,
  };
}
