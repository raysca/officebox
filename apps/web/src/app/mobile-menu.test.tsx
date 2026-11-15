import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { setMediaQuery } from "../test/media";
import { renderApp } from "../test/render-app";
import { DESKTOP_QUERY } from "./layout/AppShell";

async function openMenu() {
  const user = userEvent.setup();
  const result = await renderApp("/");
  const trigger = screen.getByRole("button", { name: "Open menu" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Menu" });
  return { ...result, user, trigger, dialog };
}

describe("mobile menu", () => {
  it("opens as a modal dialog with focus inside and the page behind made inert", async () => {
    const { trigger, dialog, container } = await openMenu();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close menu" }));
    // The app's own container is inert while the dialog is open.
    expect(container.hasAttribute("inert")).toBe(true);
    expect(within(dialog).getByRole("navigation", { name: "Main" })).toBeDefined();
  });

  it("traps Tab and Shift+Tab inside the dialog", async () => {
    const { user, dialog } = await openMenu();
    const close = within(dialog).getByRole("button", { name: "Close menu" });
    const links = within(dialog).getAllByRole("link");
    const last = links[links.length - 1];

    // Forward through every control and wrap from the last back to the first.
    for (const link of links) {
      await user.tab();
      expect(document.activeElement).toBe(link);
    }
    await user.tab();
    expect(document.activeElement).toBe(close);

    // Backward from the first wraps to the last.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes on Escape and returns focus to the menu button", async () => {
    const { user, trigger, container } = await openMenu();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.hasAttribute("inert")).toBe(false);
  });

  it("closes with the close button and returns focus to the menu button", async () => {
    const { user, trigger, dialog } = await openMenu();
    await user.click(within(dialog).getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes after following a link and focuses the new page's heading", async () => {
    const { user, dialog, router } = await openMenu();
    await user.click(within(dialog).getByRole("link", { name: "Documents" }));
    const heading = await screen.findByRole("heading", { level: 1, name: "Documents" });
    expect(router.state.location.pathname).toBe("/documents");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("closes by itself when the window grows to the desktop layout", async () => {
    const { trigger } = await openMenu();
    act(() => setMediaQuery(DESKTOP_QUERY, true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("points aria-controls at the menu only while it exists", async () => {
    const user = userEvent.setup();
    await renderApp("/");
    const trigger = screen.getByRole("button", { name: "Open menu" });
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    await user.click(trigger);
    const id = trigger.getAttribute("aria-controls");
    expect(id && document.getElementById(id)).toBe(screen.getByRole("dialog", { name: "Menu" }));
  });
});
