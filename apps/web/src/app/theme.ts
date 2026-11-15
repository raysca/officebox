import { useCallback, useEffect, useState } from "react";

/**
 * Theme preference, stored per device in localStorage. "system" (the default) follows the operating
 * system's light or dark setting through CSS alone; "light" and "dark" set data-theme on <html>,
 * which the tokens in index.css respond to. public/theme-init.js applies the stored value before the
 * app loads, so keep the key and values in sync with it.
 */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "officebox.theme";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function applyThemePreference(preference: ThemePreference, root: HTMLElement = document.documentElement) {
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
}

function storeThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable: the choice lasts until the page is reloaded.
  }
}

/** The current preference and a setter that applies and stores it. Stays in sync across tabs. */
export function useThemePreference(): [ThemePreference, (preference: ThemePreference) => void] {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    applyThemePreference(preference);
  }, [preference]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setPreferenceState(readThemePreference());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    storeThemePreference(next);
    setPreferenceState(next);
  }, []);

  return [preference, setPreference];
}
