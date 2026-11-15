import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
