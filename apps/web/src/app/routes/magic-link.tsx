import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiRequestError, describeApiError, errorCodeOf, errorReasonOf } from "../../lib/api/client";
import { meQuery, meQueryKey } from "../../lib/api/identity";
import { confirmMagicLink, lookupMagicLink } from "../../lib/api/onboarding";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Link } from "../../lib/ui/Link";
import { toastStore } from "../../lib/ui/toast-store";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";
import { useFragmentToken } from "./fragment-token";

const copy = messages.magicLink;

/**
 * The magic-link confirmation page, `/sign-in/link#t=…` (Identity §4.4, §7 screen 3; Platform §10):
 * "Sign in to *Workspace* as **email**" → Continue. Opening it changes nothing (mail scanners only
 * ever GET it); only Continue's POST uses the link. The email is shown prominently, so a link someone
 * else shared (login CSRF) is obvious.
 */
export function MagicLinkPage() {
  const token = useFragmentToken();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const lookup = useQuery({
    queryKey: ["magic-link", "lookup", token],
    queryFn: () => lookupMagicLink(token ?? ""),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const confirm = useMutation({
    mutationFn: () => confirmMagicLink(token ?? ""),
    meta: { errorToast: false },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: meQueryKey });
      const me = await queryClient.fetchQuery(meQuery).catch(() => null);
      if (me && me.passkeyCount === 0) {
        toastStore.show(copy.signedInAddPasskey, "info");
        await navigate({ to: "/settings/passkeys", replace: true });
        return;
      }
      await navigate({ to: "/", replace: true });
    },
    onError: (failure) => {
      if (errorCodeOf(failure) === "gone") setError(copy.invalid);
      else if (errorReasonOf(failure) === "magic_link_failed") setError(copy.failed);
      else
        setError(
          failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : messages.errors.generic,
        );
    },
  });

  if (token === null) {
    return (
      <PublicPage title={copy.title}>
        <Alert>{copy.missing}</Alert>
        <p>
          <Link to="/sign-in">{copy.newLink}</Link>
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
        <p>
          <Link to="/sign-in">{copy.newLink}</Link>
        </p>
      </PublicPage>
    );
  }
  return (
    <PublicPage title={copy.title}>
      <div className="flex flex-col gap-2">
        <p>{copy.confirm(lookup.data.workspaceName)}</p>
        <p className="text-xl font-semibold break-all">{lookup.data.email}</p>
        <p className="text-sm text-muted">{copy.notYou}</p>
      </div>
      {error ? (
        <Alert>
          <span>{error} </span>
          <Link to="/sign-in">{copy.newLink}</Link>
        </Alert>
      ) : null}
      <div>
        <Button variant="primary" disabled={confirm.isPending || error !== null} onClick={() => confirm.mutate()}>
          {confirm.isPending ? copy.continuing : copy.continue}
        </Button>
      </div>
    </PublicPage>
  );
}
