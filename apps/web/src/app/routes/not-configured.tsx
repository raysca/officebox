import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";

const copy = messages.notConfigured;

/** The operator guidance shown wherever the server says sign-in isn't configured (`unavailable`). */
function NotConfiguredNotice() {
  return (
    <Alert tone="info">
      <span className="flex flex-col gap-2">
        <span>{copy.description}</span>
        <span>{copy.ownerHint}</span>
      </span>
    </Alert>
  );
}

/**
 * Shown when the Worker answers `unavailable` because its identity secrets aren't set (a deploy path
 * that didn't create them). Names where the instructions are, never any secret value.
 */
export function NotConfiguredPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <PublicPage title={copy.title}>
      <NotConfiguredNotice />
      <div>
        <Button
          variant="primary"
          onClick={() => {
            queryClient.clear();
            void navigate({ to: "/" });
          }}
        >
          {copy.retry}
        </Button>
      </div>
    </PublicPage>
  );
}
