// Lets hash-wasm's argon2id run in Workers.
//
// hash-wasm calls WebAssembly.compile(bytes) on base64-embedded binaries; Workers refuse runtime compilation.
// Wrangler compiles imported .wasm files at upload time into WebAssembly.Module objects, so this shim answers
// hash-wasm's compile() calls with those precompiled modules, matched by exact byte length. Instantiating a
// Module is allowed. Spike-grade: production would vendor hash-wasm's ~200-line argon2 wrapper (MIT) and pass
// the modules in directly instead of patching a global.
import argon2Module from "./wasm/argon2.wasm";
import blake2bModule from "./wasm/blake2b.wasm";
import { ARGON2_WASM_BYTES, BLAKE2B_WASM_BYTES } from "./wasm/sizes";

const byLength = new Map<number, WebAssembly.Module>([
  [ARGON2_WASM_BYTES, argon2Module],
  [BLAKE2B_WASM_BYTES, blake2bModule],
]);

let installed = false;
export function installArgon2Shim(): void {
  if (installed) return;
  installed = true;
  // workers-types omits WebAssembly.compile (calling it with bytes always fails in Workers), hence the cast.
  const wasm = WebAssembly as unknown as { compile(bytes: BufferSource): Promise<WebAssembly.Module> };
  const original = wasm.compile.bind(WebAssembly);
  wasm.compile = async (bytes: BufferSource): Promise<WebAssembly.Module> => {
    const pre = byLength.get(bytes.byteLength);
    return pre ?? original(bytes);
  };
}
