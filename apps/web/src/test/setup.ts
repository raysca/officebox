import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { toastStore } from "../lib/ui/toast-store";
import { installMatchMedia } from "./media";

beforeEach(() => {
  installMatchMedia();
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
