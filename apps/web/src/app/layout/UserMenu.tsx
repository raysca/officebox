import { useEffect, useId, useRef, useState } from "react";
import { IconButton } from "../../lib/ui/Button";
import { UserIcon } from "../../lib/ui/icons";
import { messages } from "../messages";

/**
 * Placeholder for the account menu (profile, preferences, sign out) that arrives with sign-in in M1.
 * A disclosure button with a popover panel: Esc or a click outside closes it.
 */
export function UserMenu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(event) => {
        // Close when focus leaves the menu entirely (Tab past it).
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <IconButton
        ref={buttonRef}
        label={messages.account.menuLabel}
        icon={<UserIcon />}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      />
      <div
        id={panelId}
        hidden={!open}
        className="absolute top-full right-0 z-30 mt-2 w-64 rounded-lg border border-border bg-raised p-4 text-sm shadow-lg"
      >
        <p>{messages.account.signedOut}</p>
      </div>
    </div>
  );
}
