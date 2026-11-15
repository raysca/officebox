/**
 * ULID generator (AGENTS §4.1): 26 Crockford base32 characters, 48-bit millisecond timestamp then
 * 80 random bits. IDs sort lexicographically by creation time.
 *
 * **Monotonic within an isolate:** when two IDs are made in the same millisecond (or the clock steps
 * backwards), the second reuses the previous timestamp and increments the random part by one, so IDs
 * from one generator always sort in creation order. After a backwards clock step, IDs keep the last
 * timestamp seen until the clock catches up, so their embedded time can run ahead of the wall clock
 * by the size of the step. Across isolates, IDs are only roughly ordered (each isolate's own clock).
 *
 * **IDs are not capabilities.** A ULID reveals its creation time and, when made in a burst, is
 * guessable from its neighbours. Never use one as a secret, token or unguessable link; those use
 * 32 random bytes (M1).
 *
 * A local implementation, not a dependency (AGENTS §4.4): it is short and uses only WebCrypto.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

export interface UlidOptions {
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Fills a buffer with random bytes. Defaults to `crypto.getRandomValues`. */
  random?: (bytes: Uint8Array) => void;
}

export type UlidGenerator = () => string;

function encodeTime(time: number): string {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`ULID time out of range: ${time}`);
  }
  let out = "";
  let t = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Creates an independent monotonic generator. Most code uses the shared `ulid()` below. */
export function createUlidGenerator(options: UlidOptions = {}): UlidGenerator {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? ((bytes: Uint8Array) => void crypto.getRandomValues(bytes));
  let lastTime = -1;
  // Random part as 16 base32 digits (5 bits each), most significant first.
  const digits = new Array<number>(RANDOM_LEN).fill(0);

  const fresh = (): void => {
    const bytes = new Uint8Array(RANDOM_LEN);
    random(bytes);
    for (let i = 0; i < RANDOM_LEN; i++) digits[i] = (bytes[i] ?? 0) & 31;
  };

  const increment = (): void => {
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      const d = digits[i] ?? 0;
      if (d < 31) {
        digits[i] = d + 1;
        return;
      }
      digits[i] = 0;
    }
    // 2^80 IDs in one millisecond: move to the next millisecond instead of wrapping around.
    lastTime += 1;
    fresh();
  };

  return () => {
    const time = now();
    if (time > lastTime) {
      lastTime = time;
      fresh();
    } else {
      increment();
    }
    return encodeTime(lastTime) + digits.map((d) => ALPHABET.charAt(d)).join("");
  };
}

/** Returns a new ULID. Monotonic within this isolate. */
export const ulid: UlidGenerator = createUlidGenerator();

/** Reads the millisecond timestamp back out of a ULID. Upper case only, like `ULID_PATTERN`. */
export function ulidTime(id: string): number {
  if (id.length !== TIME_LEN + RANDOM_LEN) throw new RangeError("Not a ULID");
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const value = ALPHABET.indexOf(id.charAt(i));
    if (value < 0) throw new RangeError("Not a ULID");
    time = time * 32 + value;
  }
  return time;
}
