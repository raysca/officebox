import { isWorkersDevHost } from "@officebox/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { registerPasskey } from "../../lib/api/identity";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { describePasskeyFailure } from "../forms";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";

/**
 * The "create your passkey" step after a POST that set an enrolment ticket cookie (Identity §4.4):
 * recovery links, owner recovery and the domain move (M1c). The ticket is HttpOnly; this page only runs
 * the registration ceremony. A ticket that expired or was replaced shows `expiredMessage`, any other
 * server refusal `failedMessage` (or the generic passkey copy).
 */
export function EnrolStep({
  title,
  description,
  button,
  pendingButton,
  expiredMessage,
  failedMessage,
  onRegistered,
}: {
  title: string;
  description: string;
  button: string;
  pendingButton: string;
  expiredMessage: string;
  failedMessage?: string;
  onRegistered: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const mutation = useMutation({
    mutationFn: registerPasskey,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      if (result.ok) {
        await onRegistered();
        return;
      }
      const failure = result.error;
      if (failure.kind === "api" && failure.error.kind === "api") {
        const reason = failure.error.error.reason;
        if (reason?.startsWith("ENROLMENT_TICKET")) {
          setExpired(true);
          return;
        }
        if (failedMessage && reason === "DOMAIN_MOVE_INVALID") {
          setError(failedMessage);
          return;
        }
      }
      setError(describePasskeyFailure(failure));
    },
  });
  return (
    <PublicPage title={title} description={description}>
      {isWorkersDevHost(window.location.host) ? <Alert tone="info">{messages.passkey.workersDevWarning}</Alert> : null}
      {expired ? <Alert>{expiredMessage}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <Button
          variant="primary"
          disabled={mutation.isPending || expired}
          onClick={() => {
            setError(null);
            mutation.mutate();
          }}
        >
          {mutation.isPending ? pendingButton : button}
        </Button>
      </div>
    </PublicPage>
  );
}
