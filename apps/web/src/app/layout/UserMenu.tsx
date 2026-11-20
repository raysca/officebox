import type { AvailabilityState } from "@officebox/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { signOut, useMe } from "../../lib/api/identity";
import { setMyDnd } from "../../lib/api/realtime";
import { useMyPresenceAndAvailability, useRealtimeClient } from "../../lib/realtime";
import { IconButton } from "../../lib/ui/Button";
import { UserIcon } from "../../lib/ui/icons";
import { messages } from "../messages";

const itemClass =
  "flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-fg hover:bg-accent-subtle " +
  "hover:text-accent-subtle-fg motion-safe:transition-colors disabled:cursor-not-allowed disabled:opacity-60";

function dotColorClass(state: AvailabilityState): string {
  switch (state) {
    case "online":
      return "bg-emerald-500";
    case "idle":
      return "bg-amber-500";
    case "dnd":
    case "scheduled_dnd":
    case "focus":
      return "bg-rose-500";
    case "away":
    case "offline":
      return "bg-muted";
  }
}

/**
 * The account menu: who is signed in, live availability + DND toggle, links to Passkeys and My devices,
 * and Sign out.
 *
 * A disclosure button with a panel of ordinary links and buttons (WAI-ARIA disclosure pattern), not
 * an ARIA `menu`: the panel holds a short list of navigation and one action, which Tab reaches in
 * order and screen readers announce as what they are, without menu-mode keyboard handling to learn.
 * Esc, a click outside or tabbing away closes it.
 */
export function UserMenu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const me = useMe().data;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const realtimeClient = useRealtimeClient();
  const { availability, presence } = useMyPresenceAndAvailability();

  const currentAvailabilityState: AvailabilityState = availability?.state ?? presence;
  const currentAvailabilityLabel = availability?.label ?? messages.account.availability[currentAvailabilityState];
  const isManualDnd = availability?.source === "manual_dnd";

  const dndMutation = useMutation({
    mutationFn: (until: number | null) => setMyDnd(until),
    onSuccess: (updated) => {
      realtimeClient?.setLocalAvailability(updated);
    },
  });

  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      setOpen(false);
      realtimeClient?.stop();
      queryClient.clear();
      await navigate({ to: "/sign-in", search: { reason: "signed-out" }, replace: true });
    },
  });

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
        className="absolute top-full right-0 z-30 mt-2 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-raised p-2 text-sm shadow-lg"
      >
        {me ? (
          <div className="border-b border-border px-3 pt-1 pb-3">
            <p className="text-muted">{messages.account.signedInAs}</p>
            <p className="truncate font-semibold">{me.user.displayName}</p>
            <p className="truncate text-muted">{me.user.email}</p>
            <div
              className="mt-2 flex items-center gap-2 text-xs text-muted"
              data-testid="user-availability-status"
              aria-live="polite"
            >
              <span
                aria-hidden="true"
                className={`inline-block h-2 w-2 rounded-full ${dotColorClass(currentAvailabilityState)}`}
              />
              <span>
                {messages.account.availabilityLabel}: {currentAvailabilityLabel}
              </span>
            </div>
            {dndMutation.isError ? (
              <p role="alert" className="mt-1 text-xs text-danger">
                {messages.account.dndError}
              </p>
            ) : null}
          </div>
        ) : null}
        <ul className="flex flex-col gap-1 pt-2">
          <li>
            <button
              type="button"
              className={itemClass}
              disabled={dndMutation.isPending}
              onClick={() => dndMutation.mutate(isManualDnd ? null : Date.now() + 60 * 60 * 1000)}
            >
              {isManualDnd ? messages.account.dndClear : messages.account.dndEnableHour}
            </button>
          </li>
          <li>
            <Link to="/settings/profile" className={itemClass} onClick={() => setOpen(false)}>
              {messages.account.profile}
            </Link>
          </li>
          <li>
            <Link to="/settings/passkeys" className={itemClass} onClick={() => setOpen(false)}>
              {messages.account.passkeys}
            </Link>
          </li>
          <li>
            <Link to="/settings/devices" className={itemClass} onClick={() => setOpen(false)}>
              {messages.account.devices}
            </Link>
          </li>
          <li>
            <button
              type="button"
              className={itemClass}
              disabled={signOutMutation.isPending}
              onClick={() => signOutMutation.mutate()}
            >
              {signOutMutation.isPending ? messages.account.signingOut : messages.account.signOut}
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}
