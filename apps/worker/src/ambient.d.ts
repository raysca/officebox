// Minimal typing for the one Node built-in the Worker uses, through `nodejs_compat` (wrangler.jsonc).
// @types/node isn't loaded here: it conflicts with @cloudflare/workers-types (spike finding).
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
