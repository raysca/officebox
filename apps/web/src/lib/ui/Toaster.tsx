import { useSyncExternalStore } from "react";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { AlertIcon, CloseIcon } from "./icons";
import { toastStore } from "./toast-store";

/**
 * Renders toasts from `toastStore`. The live region is always in the page, so screen readers announce
 * a toast when it's added; errors use role="alert" to be announced straight away.
 */
export function Toaster() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 left-4 z-40 flex flex-col items-end gap-2 sm:left-auto sm:w-96"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === "error" ? "alert" : "status"}
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
      ))}
    </div>
  );
}
