import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { DIALOG_EXEMPT_ATTRIBUTE } from "./Dialog";
import { AlertIcon, CloseIcon } from "./icons";
import { toastStore, type Toast } from "./toast-store";

/**
 * Renders toasts from `toastStore`.
 *
 * - Two live regions are always in the page, so screen readers announce a toast when it's added:
 *   a polite `status` region for information and an `alert` region for errors. The container itself
 *   is a plain div, so live regions never nest.
 * - It's rendered in a portal directly under <body> and marked exempt from the Dialog's `inert`, so a
 *   toast raised while a dialog is open is still announced and can be dismissed with a pointer (or
 *   from the keyboard once the dialog closes; toasts stay until dismissed).
 */
export function Toaster() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);
  const errors = toasts.filter((t) => t.tone === "error");
  const info = toasts.filter((t) => t.tone === "info");

  return createPortal(
    <div
      {...{ [DIALOG_EXEMPT_ATTRIBUTE]: "" }}
      className="pointer-events-none fixed right-4 bottom-4 left-4 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:w-96"
    >
      <div role="alert" className="flex w-full flex-col gap-2">
        {errors.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
      <div role="status" className="flex w-full flex-col gap-2">
        {info.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </div>,
    document.body,
  );
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
        onClick={() => toastStore.dismiss(toast.id)}
        className="shrink-0"
      />
    </div>
  );
}
