import type { CompleteDomainMoveResult } from "@officebox/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiRequestError, describeApiError, errorCodeOf } from "../../lib/api/client";
import { meQueryKey } from "../../lib/api/identity";
import { openDomainMoveLink } from "../../lib/api/recovery";
import { supportsPasskeys } from "../../lib/api/webauthn";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { toastStore } from "../../lib/ui/toast-store";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";
import { EnrolStep } from "./enrol-step";
import { useFragmentToken } from "./fragment-token";

const copy = messages.domainComplete;

/**
 * The domain move's commit step, `/admin/domain/complete#t=…`, opened on the **new** address (Identity
 * §4.4, §7 screen 8): Continue (the link's POST sets an enrolment ticket for this address), then a new
 * passkey whose relying party is this address. That registration commits the move. Opening the page
 * changes nothing. It never asks `/api/me`: until the move commits this address answers only the
 * move-completion routes.
 */
export function DomainCompletePage() {
  const token = useFragmentToken();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<CompleteDomainMoveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = useMutation({
    mutationFn: () => openDomainMoveLink(token ?? ""),
    meta: { errorToast: false },
    onSuccess: setOpened,
    onError: (e) => {
      const code = errorCodeOf(e);
      if (code === "gone" || code === "not_found") setError(copy.invalid);
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
  if (!supportsPasskeys()) {
    return (
      <PublicPage title={copy.title}>
        <Alert>{messages.passkey.unsupported}</Alert>
      </PublicPage>
    );
  }
  if (opened) {
    return (
      <EnrolStep
        title={copy.passkeyTitle}
        description={copy.passkeyDescription(opened.email)}
        button={copy.createPasskey}
        pendingButton={copy.creatingPasskey}
        expiredMessage={copy.invalid}
        failedMessage={copy.failed}
        onRegistered={async () => {
          toastStore.show(copy.done, "info");
          await queryClient.invalidateQueries({ queryKey: meQueryKey });
          await navigate({ to: "/", replace: true });
        }}
      />
    );
  }
  return (
    <PublicPage title={copy.title}>
      <p>{copy.explain(window.location.origin)}</p>
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <Button variant="primary" disabled={open.isPending || error !== null} onClick={() => open.mutate()}>
          {open.isPending ? copy.continuing : copy.continue}
        </Button>
      </div>
    </PublicPage>
  );
}
