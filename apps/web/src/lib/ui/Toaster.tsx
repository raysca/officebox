import { useLayoutEffect, useState, useSyncExternalStore, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { dialogToastSlot, INERT_EXEMPT_ATTRIBUTE } from "./dialog-stack";
import { AlertIcon, CloseIcon } from "./icons";
import { toastStore, type Toast } from "./toast-store";

/**
 * Renders toasts from `toastStore`.
 *
 * - Two live regions are always mounted, so screen readers announce a toast when it's added: an
 *   `alert` region for errors and a polite `status` region for information. The container is a plain
 *   div, so live regions never nest. Both regions are `aria-atomic="false"` with
 *   `aria-relevant="additions"`, so a new toast is read on its own, not with the earlier ones.
 * - With no dialog open, toasts float at the bottom of the window (index.css keeps scroll-padding
 *   clear of them). While a dialog is open they sit inside the top dialog's toast slot instead:
 *   below its content, in the layout rather than floating over its actions, inside its focus trap
 *   (so the dismiss buttons are reachable with Tab) and outside the inert page.
 * - React portals into one root element for the Toaster's whole life, and that element is *moved*
 *   between <body> and the slot. Changing the portal container instead would remount the live
 *   regions and every toast, and screen readers would announce the existing alerts again.
 */
export function Toaster() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);
  const slot = useSyncExternalStore(dialogToastSlot.subscribe, dialogToastSlot.getSnapshot, () => null);
  const [root] = useState(() => {
    const el = document.createElement("div");
    el.setAttribute(INERT_EXEMPT_ATTRIBUTE, "");
    return el;
  });

  // Move (never re-create) the root to wherever toasts belong now.
  useLayoutEffect(() => {
    const target = slot ?? document.body;
    if (root.parentElement !== target) target.appendChild(root);
    root.removeAttribute("inert");
  }, [slot, root]);
  useLayoutEffect(() => () => root.remove(), [root]);

  const errors = toasts.filter((t) => t.tone === "error");
  const info = toasts.filter((t) => t.tone === "info");
  const inDialog = slot !== null;

  return createPortal(
    <div
      data-toaster={inDialog ? "dialog" : "window"}
      className={
        inDialog
          ? "flex flex-col gap-2 has-[[data-toast]]:border-t has-[[data-toast]]:border-border has-[[data-toast]]:p-3"
          : "pointer-events-none fixed right-4 bottom-4 left-4 z-40 flex flex-col items-end gap-2 sm:left-auto sm:w-96"
      }
    >
      <div role="alert" aria-atomic="false" aria-relevant="additions" className="flex w-full flex-col gap-2">
        {errors.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
      <div role="status" aria-atomic="false" aria-relevant="additions" className="flex w-full flex-col gap-2">
        {info.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </div>,
    root,
  );
}

/**
 * Dismisses a toast and keeps keyboard focus somewhere useful once its button disappears: the next
 * toast's dismiss button (or the previous one, for the last), else the dialog, else <main>.
 */
function dismiss(event: MouseEvent<HTMLButtonElement>, id: number) {
  const button = event.currentTarget;
  const toaster = button.closest("[data-toaster]");
  const buttons = toaster ? Array.from(toaster.querySelectorAll<HTMLElement>("[data-toast-dismiss]")) : [];
  const index = buttons.indexOf(button);
  const next = buttons[index + 1] ?? buttons[index - 1];
  const fallback = button.closest<HTMLElement>('[role="dialog"]') ?? document.querySelector<HTMLElement>("main");
  toastStore.dismiss(id);
  (next ?? fallback)?.focus();
}

function ToastItem({ toast }: { toast: Toast }) {
  return (
    <div
      data-toast={toast.tone}
      className={cx(
        "pointer-events-auto flex w-full items-start gap-3 rounded-lg border bg-raised py-2 pr-2 pl-4 shadow-lg",
        toast.tone === "error" ? "border-danger" : "border-border-strong",
      )}
    >
      {toast.tone === "error" ? <AlertIcon className="mt-2 shrink-0 text-danger" /> : null}
      <p className="flex-1 py-2 text-sm">{toast.message}</p>
      <IconButton
        label="Dismiss notification"
        icon={<CloseIcon />}
        data-toast-dismiss=""
        onClick={(event) => dismiss(event, toast.id)}
        className="shrink-0"
      />
    </div>
  );
}
