// The few Node built-ins the Node-run tests use. @types/node isn't loaded in this workspace: it
// conflicts with @cloudflare/workers-types (spike finding).
declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function statSync(path: string): { isDirectory(): boolean };
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
