import ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import mainSource from "../main.tsx?raw";

/**
 * This file deliberately does not import ./zod-config itself: it loads the real entry point
 * (main.tsx) and checks that its import chain leaves Zod jitless, which a direct import would
 * satisfy trivially.
 */
describe("zod-config", () => {
  afterAll(() => {
    document.getElementById("root")?.remove();
  });

  it("is the first import of main.tsx", () => {
    // Parse the module rather than pattern-match it, so comments and multi-line imports don't matter.
    const source = ts.createSourceFile("main.tsx", mainSource, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    const firstImport = source.statements.find(ts.isImportDeclaration);
    expect(firstImport).toBeDefined();
    expect(firstImport!.importClause).toBeUndefined(); // a bare side-effect import
    expect((firstImport!.moduleSpecifier as ts.StringLiteral).text).toBe("./lib/zod-config");
  });

  it("leaves Zod jitless once the app's entry point has loaded", async () => {
    expect(z.core.globalConfig.jitless).not.toBe(true);
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    await import("../main");

    expect(z.core.globalConfig.jitless).toBe(true);
  });
});
