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
  it("announces errors as alerts, de-duplicates them and dismisses on request", async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    act(() => {
      toastStore.show("Can't reach the server.", "error");
      toastStore.show("Can't reach the server.", "error");
      toastStore.show("Saved.", "info");
    });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("Saved.");

    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps at most three", () => {
    render(<Toaster />);
    act(() => {
      for (const n of [1, 2, 3, 4]) toastStore.show(`Message ${n}`);
    });
    expect(screen.getAllByRole("status").map((el) => el.querySelector("p")?.textContent)).toEqual([
      "Message 2",
      "Message 3",
      "Message 4",
    ]);
  });
});
