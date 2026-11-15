import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { setReauthHandler } from "../lib/api/client";
import { meQueryKey, reauthenticate } from "../lib/api/identity";
import { Alert } from "../lib/ui/Alert";
import { Button } from "../lib/ui/Button";
import { Dialog } from "../lib/ui/Dialog";
import { describePasskeyFailure } from "./forms";
import { messages } from "./messages";

const copy = messages.reauth;

/**
 * The step-up prompt (Identity §4.5). Registered with the API client: when a request comes back
 * `reauth_required`, the client calls the handler, which opens this dialog. "Use passkey" runs
 * `POST /me/reauth`; on success the dialog closes and the client retries the original request. Cancel
 * (or Esc) resolves false and the original error stands.
 */
export function ReauthPrompt() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      setReauthHandler(
        () =>
          new Promise<boolean>((resolve) => {
            resolver.current = resolve;
            setError(null);
            setOpen(true);
          }),
      ),
    [],
  );

  function finish(ok: boolean) {
    setOpen(false);
    setPending(false);
    resolver.current?.(ok);
    resolver.current = null;
  }

  async function confirm() {
    setPending(true);
    setError(null);
    const result = await reauthenticate();
    if (result.ok) {
      await queryClient.invalidateQueries({ queryKey: meQueryKey });
      finish(true);
      return;
    }
    setPending(false);
    setError(result.error.kind === "api" ? copy.failed : describePasskeyFailure(result.error));
  }

  return (
    <Dialog
      open={open}
      onClose={() => finish(false)}
      title={copy.title}
      closeLabel={copy.cancel}
      initialFocusRef={confirmRef}
    >
      <div className="flex flex-col gap-4">
        <p>{copy.description}</p>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => finish(false)}>{copy.cancel}</Button>
          <Button ref={confirmRef} variant="primary" disabled={pending} onClick={() => void confirm()}>
            {pending ? copy.confirming : copy.confirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
