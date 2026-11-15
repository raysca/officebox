import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { getTabbable } from "./focus";
import { IconButton } from "./Button";
import { CloseIcon } from "./icons";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name, shown as its heading. */
  title: string;
  children: ReactNode;
  /** Where focus goes on open; defaults to the first tabbable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** "left" slides in as a drawer (the mobile menu); "center" is a classic modal. */
  placement?: "left" | "center";
  id?: string;
  closeLabel?: string;
}

/**
 * A modal dialog (WAI-ARIA APG dialog pattern).
 *
 * - Rendered in a portal directly under <body>; everything else on the page is made `inert`, so it can't be clicked,
 *   focused or read by a screen reader while the dialog is open.
 * - Focus moves inside on open, Tab and Shift+Tab wrap within the dialog, and focus returns to the
 *   element that opened it on close.
 * - Esc and a click on the backdrop close it.
 *
 * Built by hand rather than on <dialog>.showModal(): the native element doesn't keep Tab inside the
 * dialog (focus can leave for the browser chrome and come back to the page), and jsdom can't test it.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  initialFocusRef,
  placement = "center",
  id,
  closeLabel = "Close",
}: DialogProps) {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Keep the latest onClose without re-running the open effect when the parent re-renders.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Make the rest of the page inert, remembering what was already inert.
    const siblings = Array.from(document.body.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== overlay,
    );
    const wasInert = siblings.map((el) => el.hasAttribute("inert"));
    for (const el of siblings) el.setAttribute("inert", "");

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    (initialFocusRef?.current ?? getTabbable(panel)[0] ?? panel).focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const tabbable = getTabbable(panel);
      const first = tabbable[0];
      const last = tabbable[tabbable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    // A safety net: if focus lands outside anyway (a script, a browser quirk), bring it back.
    function onFocusIn(event: FocusEvent) {
      if (panel && event.target instanceof Node && !panel.contains(event.target)) {
        (getTabbable(panel)[0] ?? panel).focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      siblings.forEach((el, i) => {
        if (!wasInert[i]) el.removeAttribute("inert");
      });
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  return createPortal(
    <div ref={overlayRef} className="fixed inset-0 z-50">
      {/* The backdrop is a pointer convenience only; keyboard users close with Esc or the button. */}
      <div aria-hidden="true" className="absolute inset-0 bg-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "absolute flex flex-col bg-raised text-fg shadow-xl",
          placement === "left"
            ? "inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border"
            : "top-1/2 left-1/2 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <IconButton label={closeLabel} icon={<CloseIcon />} onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
