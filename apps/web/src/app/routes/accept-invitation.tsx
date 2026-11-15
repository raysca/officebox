import { isWorkersDevHost, type InvitationLookup } from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { ApiRequestError, describeApiError, errorCodeOf, errorReasonOf } from "../../lib/api/client";
import { meQuery, meQueryKey, registerPasskey, signOut } from "../../lib/api/identity";
import { acceptInvitation, lookupInvitation } from "../../lib/api/onboarding";
import { supportsPasskeys } from "../../lib/api/webauthn";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Link } from "../../lib/ui/Link";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import {
  describePasskeyFailure,
  focusFirstInvalid,
  handleError,
  nameError,
  suggestHandle,
  type FieldErrors,
} from "../forms";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";
import { useFragmentToken } from "./fragment-token";

const copy = messages.invitation;

function lookupError(error: unknown): string {
  const reason = errorReasonOf(error);
  if (reason === "invitation_expired") return copy.expired;
  if (reason === "invitation_in_progress") return copy.inProgress;
  if (errorCodeOf(error) === "gone") return copy.invalid;
  return error instanceof ApiRequestError ? describeApiError(error.detail) : messages.errors.generic;
}

/**
 * Accepting an invitation, `/invitations/accept#t=…` (Identity §4.3, §7 screen 4): the invited email
 * shown prominently and fixed, a name and @handle (suggested from the name), then a passkey with the
 * enrolment ticket the accept POST set. An invitation reopened before a passkey was registered goes
 * straight to the passkey. Someone already signed in is asked to sign out first.
 */
export function AcceptInvitationPage() {
  const token = useFragmentToken();
  const queryClient = useQueryClient();
  const [enrolledEmail, setEnrolledEmail] = useState<string | null>(null);
  const signedIn = useQuery({ ...meQuery, retry: false });
  const lookup = useQuery({
    queryKey: ["invitation", "lookup", token],
    queryFn: () => lookupInvitation(token ?? ""),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  if (token === null) {
    return (
      <PublicPage title={copy.title}>
        <Alert>{copy.missing}</Alert>
      </PublicPage>
    );
  }
  if (lookup.isPending || signedIn.isPending) {
    return (
      <PublicPage title={copy.title}>
        <p role="status">{copy.loading}</p>
      </PublicPage>
    );
  }
  if (lookup.isError) {
    return (
      <PublicPage title={copy.title}>
        <Alert>{lookupError(lookup.error)}</Alert>
      </PublicPage>
    );
  }
  if (signedIn.data) {
    return (
      <PublicPage title={copy.title}>
        <Alert tone="info">{copy.signedInAs(signedIn.data.user.displayName)}</Alert>
        <div>
          <Button
            onClick={() =>
              void signOut()
                .catch(() => undefined)
                .then(() => queryClient.resetQueries({ queryKey: meQueryKey }))
            }
          >
            {copy.signOut}
          </Button>
        </div>
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
  if (enrolledEmail) return <PasskeyStep email={enrolledEmail} />;
  return <AcceptForm token={token} invitation={lookup.data} onEnrolled={setEnrolledEmail} />;
}

type Field = "name" | "handle";

function AcceptForm({
  token,
  invitation,
  onEnrolled,
}: {
  token: string;
  invitation: InvitationLookup;
  onEnrolled: (email: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<Field, string>>({ name: "", handle: "" });
  const [handleEdited, setHandleEdited] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const resuming = invitation.state === "resume";

  const mutation = useMutation({
    mutationFn: acceptInvitation,
    meta: { errorToast: false },
    onSuccess: (result) => onEnrolled(result.email),
    onError: (failure) => {
      const reason = errorReasonOf(failure);
      if (reason === "handle_taken") {
        setErrors({ handle: copy.handleTaken });
        requestAnimationFrame(() => focusFirstInvalid(formRef.current));
        return;
      }
      if (reason === "already_member") return setFormError(copy.alreadyMember);
      setFormError(lookupError(failure));
    },
  });

  const set = (field: Field) => (value: string) => {
    setValues((current) => {
      const next = { ...current, [field]: value };
      if (field === "name" && !handleEdited) next.handle = suggestHandle(value);
      return next;
    });
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (resuming) {
      mutation.mutate({ token });
      return;
    }
    const found: FieldErrors<Field> = {};
    const nameProblem = nameError(values.name);
    const handleProblem = handleError(values.handle);
    if (nameProblem) found.name = nameProblem;
    if (handleProblem) found.handle = handleProblem;
    setErrors(found);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    mutation.mutate({ token, name: values.name.trim(), handle: values.handle.trim().toLowerCase() });
  }

  return (
    <PublicPage
      title={copy.title}
      description={resuming ? copy.resumeDescription : copy.description(invitation.workspaceName)}
    >
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
        <p>{copy.invitedAs}</p>
        <p className="text-xl font-semibold break-all">{invitation.email}</p>
        {invitation.role === "admin" ? <p>{copy.roleAdmin}</p> : null}
        <p className="text-sm text-muted">{copy.notYou}</p>
      </div>
      {formError ? <Alert>{formError}</Alert> : null}
      <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        {resuming ? null : (
          <>
            <TextField
              label={copy.nameLabel}
              value={values.name}
              onChange={(e) => set("name")(e.target.value)}
              error={errors.name}
              required
              autoComplete="name"
            />
            <TextField
              label={copy.handleLabel}
              hint={copy.handleHint}
              value={values.handle}
              onChange={(e) => {
                setHandleEdited(true);
                set("handle")(e.target.value);
              }}
              error={errors.handle}
              required
              autoComplete="nickname"
              autoCapitalize="none"
              spellCheck={false}
            />
          </>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? copy.accepting : resuming ? copy.resume : copy.accept}
          </Button>
        </div>
      </form>
    </PublicPage>
  );
}

function PasskeyStep({ email }: { email: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const mutation = useMutation({
    mutationFn: registerPasskey,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      if (result.ok) {
        toastStore.show(copy.welcome, "info");
        await queryClient.invalidateQueries({ queryKey: meQueryKey });
        await navigate({ to: "/", replace: true });
        return;
      }
      const failure = result.error;
      if (
        failure.kind === "api" &&
        failure.error.kind === "api" &&
        failure.error.error.reason?.startsWith("ENROLMENT_TICKET")
      ) {
        setExpired(true);
        return;
      }
      setError(describePasskeyFailure(failure));
    },
  });
  return (
    <PublicPage title={copy.passkeyTitle} description={copy.passkeyDescription(email)}>
      {isWorkersDevHost(window.location.host) ? <Alert tone="info">{messages.passkey.workersDevWarning}</Alert> : null}
      {expired ? <Alert>{copy.ticketExpired}</Alert> : null}
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
          {mutation.isPending ? copy.creatingPasskey : copy.createPasskey}
        </Button>
      </div>
      {expired ? (
        <p>
          <Link to="/sign-in">{messages.signIn.title}</Link>
        </p>
      ) : null}
    </PublicPage>
  );
}
