import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render-app";
import { THEME_STORAGE_KEY, useThemePreference } from "./theme";

const root = document.documentElement;

describe("theme toggle", () => {
  it("follows the system by default", async () => {
    await renderApp("/");
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" });
    expect(select.value).toBe("system");
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("applies and stores an explicit choice, and returns to the system theme", async () => {
    const user = userEvent.setup();
    await renderApp("/");
    const select = screen.getByRole("combobox", { name: "Theme" });

    await user.selectOptions(select, "dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.selectOptions(select, "light");
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    await user.selectOptions(select, "system");
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("restores the stored choice on load", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    await renderApp("/");
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value).toBe("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores an invalid stored value", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "purple");
    await renderApp("/");
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value).toBe("system");
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("follows a change made in another tab", async () => {
    await renderApp("/");
    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "light");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: THEME_STORAGE_KEY,
          newValue: "light",
          storageArea: window.localStorage,
        }),
      );
    });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value).toBe("light");
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("ignores storage events from sessionStorage", async () => {
    await renderApp("/");
    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: THEME_STORAGE_KEY,
          newValue: "dark",
          storageArea: window.sessionStorage,
        }),
      );
    });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value).toBe("system");
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("remembers the choice for this page when storage is blocked", async () => {
    const user = userEvent.setup();
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    try {
      const first = await renderApp("/");
      await user.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "dark");
      expect(root.getAttribute("data-theme")).toBe("dark");
      // Every consumer unmounts, then the shell mounts again.
      first.unmount();
      await renderApp("/");
      expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value).toBe("dark");
    } finally {
      blocked.mockRestore();
      // Clear the in-memory choice for later tests (storage works again, so it's stored instead).
      await user.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "system");
    }
  });

  it("remembers the choice for this page when storage can be read but not written", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    try {
      const first = await renderApp("/");
      await user.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "dark");
      first.unmount();
      await renderApp("/");
      expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value).toBe("dark");
    } finally {
      setItem.mockRestore();
      // Clear the in-memory choice for later tests.
      await user.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "system");
    }
  });

  it("keeps every consumer in sync", async () => {
    const user = userEvent.setup();
    function Second() {
      const [preference] = useThemePreference();
      return <output aria-label="Second consumer">{preference}</output>;
    }
    await renderApp("/");
    render(<Second />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "dark");
    expect(screen.getByLabelText("Second consumer").textContent).toBe("dark");
  });
});
