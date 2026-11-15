import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "../lib/ui/Toaster";
import { toastStore } from "../lib/ui/toast-store";
import { renderApp } from "../test/render-app";
import { AppErrorBoundary } from "./ErrorPage";

/**
 * axe in jsdom for states the end-to-end suite can't reach yet without test-only routes: a visible
 * error toast and the error page. jsdom doesn't lay out or paint, so colour contrast is left to the
 * Playwright axe runs and tokens.test.ts; every other WCAG 2.2 A/AA rule runs.
 */
async function expectNoViolations(context: Element = document.body) {
  const results = await axe.run(context, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }))).toEqual([]);
}

describe("axe (jsdom)", () => {
  it("the shell with an error and an info toast visible", async () => {
    await renderApp("/");
    act(() => {
      toastStore.show("Can't reach the server.", "error");
      toastStore.show("Saved.", "info");
    });
    expect(screen.getByRole("alert")).toBeDefined();
    await expectNoViolations();
  });

  it("an error toast raised while the mobile menu is open", async () => {
    const user = userEvent.setup();
    await renderApp("/");
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    act(() => {
      toastStore.show("Can't reach the server.", "error");
    });
    await expectNoViolations();
  });

  it("the error page", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Boom(): never {
      throw new Error("x");
    }
    render(
      <div lang="en">
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>
        <Toaster />
      </div>,
    );
    await expectNoViolations();
    consoleError.mockRestore();
  });
});
