import type { UseQueryResult } from "@tanstack/react-query";
import { ApiRequestError, describeApiError } from "../../lib/api/client";
import { useMe } from "../../lib/api/identity";
import { Alert } from "../../lib/ui/Alert";
import { Link } from "../../lib/ui/Link";
import { messages } from "../messages";
import { Page } from "../Page";

/**
 * The admin area's landing page (Admin §3). M1b brings Invitations and Settings, M1c Members (recovery
 * links and email changes) and the workspace address (owners); the other admin pages
 * arrive with their milestones. Shown only to owners and admins (the nav item asks the engine); every
 * page's API asks again.
 */
export function AdminPage() {
  // An affordance only: the domain move's API asks the engine (owners only).
  const isOwner = useMe().data?.user.role === "owner";
  return (
    <Page title={messages.areas.admin.label} description={messages.areas.admin.description}>
      <nav aria-label={messages.admin.sections}>
        <ul className="grid gap-4 sm:grid-cols-2">
          <li className="rounded-lg border border-border p-4">
            <p className="font-medium">
              <Link to="/admin/invitations">{messages.admin.invitationsLink}</Link>
            </p>
            <p className="text-sm text-muted">{messages.admin.invitationsSummary}</p>
          </li>
          <li className="rounded-lg border border-border p-4">
            <p className="font-medium">
              <Link to="/admin/settings">{messages.admin.settingsLink}</Link>
            </p>
            <p className="text-sm text-muted">{messages.admin.settingsSummary}</p>
          </li>
          <li className="rounded-lg border border-border p-4">
            <p className="font-medium">
              <Link to="/admin/members">{messages.admin.membersLink}</Link>
            </p>
            <p className="text-sm text-muted">{messages.admin.membersSummary}</p>
          </li>
          {isOwner ? (
            <li className="rounded-lg border border-border p-4">
              <p className="font-medium">
                <Link to="/admin/domain">{messages.admin.domainLink}</Link>
              </p>
              <p className="text-sm text-muted">{messages.admin.domainSummary}</p>
            </li>
          ) : null}
        </ul>
      </nav>
    </Page>
  );
}

/** A load failure with a retry button, shared by the admin pages. */
export function LoadFailure({ query }: { query: UseQueryResult<unknown> }) {
  const detail =
    query.error instanceof ApiRequestError ? describeApiError(query.error.detail) : messages.admin.loadFailed;
  return (
    <Alert>
      <span>{detail} </span>
      <button type="button" className="underline underline-offset-2" onClick={() => void query.refetch()}>
        {messages.admin.retry}
      </button>
    </Alert>
  );
}
