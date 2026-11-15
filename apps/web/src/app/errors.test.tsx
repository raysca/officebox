import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "../lib/ui/Toaster";
import { toastStore } from "../lib/ui/toast-store";
import { AppErrorBoundary, RouteErrorPage } from "./ErrorPage";

function Boom(): never {
  throw new Error("secret internal detail");
}

describe("error pages", () => {
  it("the app boundary shows an accessible error page without leaking the error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    const main = screen.getByRole("main");
    const heading = within(main).getByRole("heading", { level: 1, name: "Something went wrong" });
    expect(document.activeElement).toBe(heading);
    expect(document.title).toBe("Something went wrong · Officebox");
    expect(within(main).getByRole("button", { name: "Reload the page" })).toBeDefined();
    expect(within(main).getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
    expect(document.body.textContent).not.toContain("secret internal detail");
    consoleError.mockRestore();
  });

  it("a route error renders inside the shell's main, without a second main landmark", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<RouteErrorPage error={new Error("x")} />);
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Something went wrong" })).toBeDefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("toasts", () => {
  it("has two always-present live regions that don't nest", () => {
    render(<Toaster />);
    const alert = screen.getByRole("alert");
    const status = screen.getByRole("status");
    expect(alert.parentElement?.closest("[role], [aria-live]")).toBeNull();
    expect(status.parentElement?.closest("[role], [aria-live]")).toBeNull();
    expect(alert.querySelector("[role], [aria-live]")).toBeNull();
    // New toasts are read on their own, not with earlier ones and their buttons.
    for (const region of [alert, status]) {
      expect(region.getAttribute("aria-atomic")).toBe("false");
      expect(region.getAttribute("aria-relevant")).toBe("additions");
    }
  });

  it("puts errors in the alert region, de-duplicates them and dismisses on request", async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    act(() => {
      toastStore.show("Can't reach the server.", "error");
      toastStore.show("Can't reach the server.", "error");
      toastStore.show("Saved.", "info");
    });
    const alert = screen.getByRole("alert");
    expect(alert.querySelectorAll("[data-toast]")).toHaveLength(1);
    expect(alert.textContent).toContain("Can't reach the server.");
    expect(screen.getByRole("status").textContent).toContain("Saved.");

    await user.click(within(alert).getByRole("button", { name: "Dismiss notification" }));
    expect(alert.querySelectorAll("[data-toast]")).toHaveLength(0);
  });

  it("keeps at most three", () => {
    render(<Toaster />);
    act(() => {
      for (const n of [1, 2, 3, 4]) toastStore.show(`Message ${n}`);
    });
    const texts = Array.from(screen.getByRole("status").querySelectorAll("[data-toast] p")).map((p) => p.textContent);
    expect(texts).toEqual(["Message 2", "Message 3", "Message 4"]);
  });

  it("moves focus to the next toast after a dismissal, then to main", async () => {
    const user = userEvent.setup();
    render(
      <main tabIndex={-1}>
        <Toaster />
      </main>,
    );
    act(() => {
      toastStore.show("One.", "info");
      toastStore.show("Two.", "info");
    });
    const [first, second] = screen.getAllByRole("button", { name: "Dismiss notification" });
    first!.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(second);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});
