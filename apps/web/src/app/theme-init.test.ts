import { describe, expect, it } from "vitest";
import script from "../../public/theme-init.js?raw";
import { THEME_PREFERENCES, THEME_STORAGE_KEY } from "./theme";

/** Runs public/theme-init.js the way the browser does before the app loads. */
function runThemeInit() {
  // Evaluates our own static file under test, as the classic <script> would run it.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test-only, trusted repository file
  const run = new Function(script) as () => void;
  run();
}

const root = document.documentElement;

describe("public/theme-init.js", () => {
  it("uses the same storage key as the app", () => {
    expect(script).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it.each(THEME_PREFERENCES.filter((p) => p !== "system"))("applies a stored %s preference", (preference) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    runThemeInit();
    expect(root.getAttribute("data-theme")).toBe(preference);
  });

  it.each(["system", "purple", ""])("leaves the system theme for %j", (value) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, value);
    runThemeInit();
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("does nothing when nothing is stored", () => {
    runThemeInit();
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});
