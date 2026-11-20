import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiRequestError, describeApiError, errorCodeOf, errorReasonOf } from "../../lib/api/client";
import { confirmEmailChange, lookupEmailChange } from "../../lib/api/recovery";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Link } from "../../lib/ui/Link";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";
import { useFragmentToken } from "./fragment-token";

const copy = messages.emailConfirm;

/**
 * The email-change confirmation page, `/me/email/confirm#t=…` (Identity §4.11; Platform §10): the new
 * address prominently, then Confirm, whose POST applies the change. Opening the page changes nothing,
 * so a mail scanner can't use the link up. Public: the person may not be signed in on this device.
 */
export function EmailConfirmPage() {
  const token = useFragmentToken();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const lookup = useQuery({
    queryKey: ["email-change", "lookup", token],
    queryFn: () => lookupEmailChange(token ?? ""),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const confirm = useMutation({
    mutationFn: () => confirmEmailChange(token ?? ""),
    meta: { errorToast: false },
    onSuccess: (result) => setDone(result.email),
    onError: (e) => {
      if (errorReasonOf(e) === "email_taken") setError(copy.taken);
      else if (errorCodeOf(e) === "gone") setError(copy.invalid);
      else setError(e instanceof ApiRequestError ? describeApiError(e.detail, "mutation") : messages.errors.generic);
    },
  });

  if (token === null) {
    return (
      <PublicPage title={copy.title}>
        <Alert>{copy.missing}</Alert>
      </PublicPage>
    );
  }
  if (done) {
    return (
      <PublicPage title={copy.title}>
        <Alert tone="info">{copy.done(done)}</Alert>
        <p>
          <Link to="/sign-in">{copy.signIn}</Link>
        </p>
      </PublicPage>
    );
  }
  if (lookup.isPending) {
    return (
      <PublicPage title={copy.title}>
        <p role="status">{copy.loading}</p>
      </PublicPage>
    );
  }
  if (lookup.isError) {
    return (
      <PublicPage title={copy.title}>
        <Alert>{errorCodeOf(lookup.error) === "gone" ? copy.invalid : messages.errors.generic}</Alert>
      </PublicPage>
    );
  }
  return (
    <PublicPage title={copy.title}>
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
        <p>{copy.confirm(lookup.data.workspaceName)}</p>
        <p className="text-xl font-semibold break-all">{lookup.data.newEmail}</p>
        <p className="text-sm text-muted">{copy.notYou}</p>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <Button variant="primary" disabled={confirm.isPending || error !== null} onClick={() => confirm.mutate()}>
          {confirm.isPending ? copy.submitting : copy.submit}
        </Button>
      </div>
    </PublicPage>
  );
}
