/**
 * A tiny external store for toasts, so code outside React (the QueryClient's error handlers) can
 * raise one. `<Toaster>` renders them. Toasts stay until dismissed: auto-dismissing an error would
 * take it away before some people can read it (WCAG 2.2.1).
 */

export type ToastTone = "error" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

const MAX_TOASTS = 3;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

// Arrow functions, so the methods can be passed around unbound (useSyncExternalStore takes them so).
export const toastStore = {
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): readonly Toast[] => toasts,
  show: (message: string, tone: ToastTone = "info"): number => {
    // The same message twice in a row (a burst of failing requests) shows once.
    const existing = toasts.find((t) => t.message === message && t.tone === tone);
    if (existing) return existing.id;
    const id = nextId++;
    toasts = [...toasts, { id, tone, message }].slice(-MAX_TOASTS);
    emit();
    return id;
  },
  dismiss: (id: number): void => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  },
  clear: (): void => {
    toasts = [];
    emit();
  },
};
