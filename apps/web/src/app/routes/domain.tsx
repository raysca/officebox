import { domainOriginSchema, type StartDomainMoveResult } from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { cancelDomainMove, domainQuery, domainQueryKey, startDomainMove } from "../../lib/api/admin";
import { ApiRequestError, describeApiError, errorReasonOf } from "../../lib/api/client";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Dialog } from "../../lib/ui/Dialog";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import { messages } from "../messages";
import { Page } from "../Page";
import { LoadFailure } from "./admin";
import { LinkField } from "./invitations";

const copy = messages.domain;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * "Move workspace to a new address" (Identity §4.4, §7 screen 8; owners). Starting needs a fresh passkey
 * confirmation (the step-up prompt asks on `reauth_required`) and shows the move link once; the move
 * commits only when that link is opened at the new address and a passkey is created there. A pending
 * move can be cancelled; it expires after 24 hours.
 */
export function DomainPage() {
  const status = useQuery(domainQuery);
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [started, setStarted] = useState<StartDomainMoveResult | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: domainQueryKey });

  const start = useMutation({
    mutationFn: startDomainMove,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      setStarted(result);
      setOrigin("");
      await refresh();
    },
    onError: (failure) => {
      if (errorReasonOf(failure) === "same_origin") {
        setError(copy.sameOrigin);
        inputRef.current?.focus();
        return;
      }
      setFormError(
        failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : messages.errors.generic,
      );
    },
  });
  const cancel = useMutation({
    mutationFn: cancelDomainMove,
    onSuccess: async () => {
      toastStore.show(copy.cancelled, "info");
      await refresh();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const parsed = domainOriginSchema.safeParse(origin);
    if (!parsed.success) {
      setError(copy.invalidOrigin);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    start.mutate(parsed.data);
  }

  return (
    <Page title={copy.title} description={copy.description}>
      {status.isPending ? <p role="status">{copy.loading}</p> : null}
      {status.isError ? <LoadFailure query={status} /> : null}
      {status.data ? (
        <>
          <section aria-labelledby="domain-current" className="flex flex-col gap-1">
            <h2 id="domain-current" className="text-lg font-semibold">
              {copy.current}
            </h2>
            <p className="break-all">{status.data.canonicalOrigin}</p>
          </section>
          {status.data.pending ? (
            <section
              aria-labelledby="domain-pending"
              className="flex flex-col gap-2 rounded-lg border border-border p-4"
            >
              <h2 id="domain-pending" className="text-lg font-semibold">
                {copy.pendingTitle}
              </h2>
              <p className="break-all">
                {copy.pending(status.data.pending.origin, dateFormat.format(new Date(status.data.pending.expiresAt)))}
              </p>
              <p className="text-sm text-muted">{copy.pendingHint}</p>
              <div>
                <Button disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                  {copy.cancel}
                </Button>
              </div>
            </section>
          ) : null}
          <section aria-labelledby="domain-start" className="flex flex-col gap-3">
            <h2 id="domain-start" className="text-lg font-semibold">
              {copy.startTitle}
            </h2>
            <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
              {formError ? <Alert>{formError}</Alert> : null}
              <TextField
                ref={inputRef}
                label={copy.originLabel}
                hint={copy.originHint}
                type="url"
                value={origin}
                onChange={(e) => {
                  setOrigin(e.target.value);
                  setError(null);
                }}
                error={error}
                required
                autoComplete="off"
                spellCheck={false}
              />
              <div>
                <Button type="submit" variant="primary" disabled={start.isPending}>
                  {start.isPending ? copy.starting : copy.start}
                </Button>
              </div>
            </form>
          </section>
        </>
      ) : null}
      {started ? (
        <Dialog open onClose={() => setStarted(null)} title={copy.linkTitle}>
          <div className="flex flex-col gap-4 p-4">
            <LinkField link={started.link} label={copy.linkField} hint={copy.linkHint} />
            <div className="flex justify-end">
              <Button onClick={() => setStarted(null)}>{copy.done}</Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Page>
  );
}
