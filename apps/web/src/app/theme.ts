import { useSyncExternalStore } from "react";

/**
 * Theme preference, stored per device in localStorage. "system" (the default) follows the operating
 * system's light or dark setting through CSS alone; "light" and "dark" set data-theme on <html>,
 * which the tokens in index.css respond to. public/theme-init.js applies the stored value before the
 * app loads; theme-init.test.ts checks the two agree on the key and values.
 *
 * The preference lives in a small external store, so every component that shows or changes it stays
 * in sync, and so does every other tab (through the storage event).
 */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "officebox.theme";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The choice made in this page when it couldn't be stored (blocked site data, a full quota, some
 * private modes), so it survives components unmounting and remounting until the page reloads.
 */
let memoryPreference: ThemePreference | null = null;

export function readThemePreference(): ThemePreference {
  // A choice that couldn't be stored (no storage, or setItem threw: quota, Safari private mode)
  // wins over whatever storage still holds.
  if (memoryPreference !== null) return memoryPreference;
  try {
    const value = storage()?.getItem(THEME_STORAGE_KEY);
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
    const store = storage();
    if (!store) throw new Error("no storage");
    if (preference === "system") store.removeItem(THEME_STORAGE_KEY);
    else store.setItem(THEME_STORAGE_KEY, preference);
    memoryPreference = null;
  } catch {
    // Storage unavailable: the choice lasts until the page is reloaded.
    memoryPreference = preference;
  }
}

let current: ThemePreference | null = null;
const listeners = new Set<() => void>();

function setCurrent(next: ThemePreference) {
  current = next;
  applyThemePreference(next);
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  // Only this origin's localStorage, and only our key (null means the storage was cleared).
  if (event.storageArea !== storage()) return;
  if (event.key === THEME_STORAGE_KEY || event.key === null) setCurrent(readThemePreference());
}

// Arrow functions, so they can be passed around unbound (useSyncExternalStore takes them so).
export const themeStore = {
  subscribe: (listener: () => void): (() => void) => {
    if (listeners.size === 0) window.addEventListener("storage", onStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        window.removeEventListener("storage", onStorage);
        // Re-read on the next subscription; another tab may change it in between.
        current = null;
      }
    };
  },
  // The app is a client-only SPA: getSnapshot also serves as the server snapshot and may touch the
  // DOM. The guard keeps it harmless if it's ever rendered without a document (SSR, a worker).
  getSnapshot: (): ThemePreference => {
    if (typeof document === "undefined") return "system";
    if (current === null) {
      current = readThemePreference();
      applyThemePreference(current);
    }
    return current;
  },
  set: (preference: ThemePreference): void => {
    storeThemePreference(preference);
    setCurrent(preference);
  },
};

/** The current preference and a setter that applies and stores it. */
export function useThemePreference(): [ThemePreference, (preference: ThemePreference) => void] {
  const preference = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getSnapshot);
  return [preference, themeStore.set];
}
