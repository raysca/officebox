import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Upgrade check (M1a-0 spike, workaround 16; Identity §9 "Account creation paths"): a static scan of the
 * installed better-auth code for every place that can insert a `user` row. Every one must go through
 * the internal adapter's hooked create (`createWithHooks(…, "user")`), which runs
 * `databaseHooks.user.create.before` and so our server-set-marker check. A raw `adapter.create({ model:
 * "user" })` in loaded code would bypass it: this test fails, and the upgrade needs review.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const nodeModules = resolve(here, "../../../../node_modules");
const roots = ["better-auth/dist", "@better-auth/core/dist", "@better-auth/passkey/dist"].map((r) =>
  join(nodeModules, r),
);

/** Plugins we load. Everything under better-auth's plugins/ other than these is never imported. */
const LOADED_PLUGINS = new Set<string>([]); // @better-auth/passkey is scanned as its own package

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (path.endsWith(".mjs")) out.push(path);
  }
  return out;
}

interface Hit {
  file: string;
  raw: boolean;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const root of roots) {
    for (const file of files(root)) {
      const rel = relative(nodeModules, file);
      const plugin = /better-auth\/dist\/plugins\/([^/]+)\//.exec(rel)?.[1];
      if ((plugin && !LOADED_PLUGINS.has(plugin)) || rel.includes("test-utils")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        const hooked = /createUser\(|createOAuthUser\(/.test(line);
        const raw = /\.create\(\{/.test(line) && /model:\s*"user"/.test(lines.slice(i, i + 3).join(" "));
        if (hooked || raw) hits.push({ file: `${rel}:${i + 1}`, raw });
      });
    }
  }
  return hits;
}

describe("every user-creating path in loaded better-auth code runs user.create.before", () => {
  it("the internal adapter's createUser and createOAuthUser end in createWithHooks(…, 'user')", () => {
    const source = readFileSync(join(nodeModules, "better-auth/dist/db/internal-adapter.mjs"), "utf8");
    expect(source).toMatch(/createUser: async[\s\S]{0,1500}?createWithHooks\(data, "user"/);
    expect(source).toMatch(/createOAuthUser: async[\s\S]{0,300}?createWithHooks\(/);
  });

  it("no raw user insert exists in loaded code", () => {
    const hits = scan();
    expect(hits.length).toBeGreaterThan(0); // the scan sees the hooked call sites
    expect(hits.filter((h) => h.raw).map((h) => h.file)).toEqual([]);
  });

  it("the pinned versions are the ones reviewed (an upgrade re-runs this review)", () => {
    const version = (pkg: string) =>
      (JSON.parse(readFileSync(join(nodeModules, pkg, "package.json"), "utf8")) as { version: string }).version;
    expect(version("better-auth")).toBe("1.7.15");
    expect(version("@better-auth/passkey")).toBe("1.7.15");
    expect(version("@simplewebauthn/server")).toBe("13.3.3");
  });
});
