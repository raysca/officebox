/**
 * The stack of open modal dialogs, innermost last, and everything derived from it.
 *
 * - **Inert:** recomputed from the whole stack on every open and close, never from per-dialog
 *   snapshots, so dialogs may close in any order. While any dialog is open, every child of <body>
 *   except the topmost dialog's overlay (and exempt elements) is inert, including children added
 *   while it's open (a MutationObserver re-applies it). When the last one closes, exactly the
 *   elements that were inert before the first opened stay inert.
 * - **Scroll lock:** the body doesn't scroll while any dialog is open.
 * - **Keyboard:** only the top dialog handles Esc and keeps focus inside itself.
 * - **Toast slot:** the top dialog's slot, where the Toaster moves while a dialog is open, so toasts
 *   stay perceivable, reachable from the keyboard and never cover the dialog.
 */

/** Body children with this attribute are never made inert (the Toaster's root, which moves itself). */
export const INERT_EXEMPT_ATTRIBUTE = "data-inert-exempt";

interface Entry {
  token: symbol;
  overlay: HTMLElement;
  toastSlot: HTMLElement;
}

const stack: Entry[] = [];

/** Body children that were inert before the first dialog opened (null when none is open). */
let inertBefore: Set<Element> | null = null;
let overflowBefore = "";
let observer: MutationObserver | null = null;
const slotListeners = new Set<() => void>();

function applyInert() {
  const children = Array.from(document.body.children);
  const top = stack[stack.length - 1];

  if (!top) {
    observer?.disconnect();
    observer = null;
    if (inertBefore) {
      for (const el of children) if (!inertBefore.has(el)) el.removeAttribute("inert");
      inertBefore = null;
      document.body.style.overflow = overflowBefore;
    }
    return;
  }

  if (!inertBefore) {
    inertBefore = new Set(children.filter((el) => el.hasAttribute("inert")));
    overflowBefore = document.body.style.overflow;
  }
  for (const el of children) {
    if (el === top.overlay || el.hasAttribute(INERT_EXEMPT_ATTRIBUTE)) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  }
  document.body.style.overflow = "hidden";

  // Watch for children added later (another portal, a third-party widget). Only childList is
  // observed, so setting `inert` here doesn't retrigger it.
  if (!observer && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => applyInert());
    observer.observe(document.body, { childList: true });
  }
}

function notifySlot() {
  for (const listener of slotListeners) listener();
}

export function pushDialog(entry: Entry) {
  stack.push(entry);
  applyInert();
  notifySlot();
}

export function removeDialog(token: symbol) {
  const index = stack.findIndex((e) => e.token === token);
  if (index < 0) return;
  stack.splice(index, 1);
  applyInert();
  notifySlot();
}

export function isTopDialog(token: symbol): boolean {
  return stack[stack.length - 1]?.token === token;
}

/** External store for the Toaster: the top dialog's toast slot, or null when no dialog is open. */
export const dialogToastSlot = {
  subscribe: (listener: () => void): (() => void) => {
    slotListeners.add(listener);
    return () => slotListeners.delete(listener);
  },
  getSnapshot: (): HTMLElement | null => stack[stack.length - 1]?.toastSlot ?? null,
};
