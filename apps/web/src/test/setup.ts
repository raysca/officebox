import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { toastStore } from "../lib/ui/toast-store";

// jsdom has no matchMedia. Report "light, wide screen, motion allowed" unless a test overrides it.
function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  );
}

beforeEach(() => {
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.title = "";
  toastStore.clear();
});
