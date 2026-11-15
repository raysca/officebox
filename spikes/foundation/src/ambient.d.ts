declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

// Minimal typing for the one node:crypto function the spike uses (avoids adding @types/node).
declare module "node:crypto" {
  export function scrypt(
    password: string,
    salt: Uint8Array,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
    callback: (err: Error | null, key: Uint8Array) => void,
  ): void;
}
