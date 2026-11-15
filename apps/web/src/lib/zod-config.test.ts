import { describe, expect, it } from "vitest";
import { z } from "zod";
import mainSource from "../main.tsx?raw";
import "./zod-config";

describe("zod-config", () => {
  it("puts Zod in jitless mode, so it never probes for eval under the CSP", () => {
    expect(z.core.globalConfig.jitless).toBe(true);
  });

  it("is the first import of main.tsx", () => {
    const firstImport = /^import\s.*$/m.exec(mainSource)?.[0];
    expect(firstImport).toBe('import "./lib/zod-config";');
  });
});
