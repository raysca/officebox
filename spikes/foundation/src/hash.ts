// Password-hashing candidates for Identity §4.4 / TDD §8.1. Spike code: measured, not production-hardened.
import { argon2id, argon2Verify } from "hash-wasm";
import { scrypt as nodeScrypt } from "node:crypto";
import { installArgon2Shim } from "./argon2-shim";
import { b64, timed } from "./pbkdf2";

export * from "./pbkdf2";

// ---- Fallback B: Argon2id via hash-wasm (WASM) ----

export interface Argon2Params {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}
export const OWASP_ARGON2ID: Argon2Params = { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 };

/** `shim: false` shows what happens with hash-wasm unmodified (runtime WASM compilation is refused). */
export function argon2(password: string, p: Argon2Params = OWASP_ARGON2ID, shim = true) {
  if (shim) installArgon2Shim();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return timed(() =>
    argon2id({
      password,
      salt,
      iterations: p.iterations,
      parallelism: p.parallelism,
      memorySize: p.memoryKiB,
      hashLength: 32,
      outputType: "encoded",
    }),
  );
}

export function argon2Check(password: string, encoded: string): Promise<boolean> {
  installArgon2Shim();
  return argon2Verify({ password, hash: encoded });
}

// ---- Bonus: native scrypt via node:crypto (nodejs_compat) ----
// OWASP minimum for scrypt: N=2^17, r=8, p=1 (128 MiB). workerd's default limit enforcer caps N*r*p at 2^20.

export function scrypt(password: string, N: number, r = 8, p = 1) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return timed(
    () =>
      new Promise<string>((resolve, reject) =>
        nodeScrypt(password, salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
          err ? reject(err) : resolve(`scrypt$${N}$${r}$${p}$${b64(salt)}$${b64(key)}`),
        ),
      ),
  );
}
