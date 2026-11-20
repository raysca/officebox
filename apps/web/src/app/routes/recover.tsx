import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { ApiRequestError, describeApiError, errorCodeOf, errorReasonOf } from "../../lib/api/client";
import { meQueryKey } from "../../lib/api/identity";
import { lookupRecoveryLink, openRecoveryLink, recoverOwner } from "../../lib/api/recovery";
import { supportsPasskeys } from "../../lib/api/webauthn";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import { emailError, focusFirstInvalid, requiredError, type FieldErrors } from "../forms";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";
import { EnrolStep } from "./enrol-step";
import { useFragmentToken } from "./fragment-token";

const copy = messages.recovery;

function failure(error: unknown): string {
  return error instanceof ApiRequestError ? describeApiError(error.detail, "mutation") : messages.errors.generic;
}

/** After the new passkey: signed in, so go home. */
function useFinish() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async () => {
    toastStore.show(copy.done, "info");
    await queryClient.invalidateQueries({ queryKey: meQueryKey });
    await navigate({ to: "/", replace: true });
  };
}

/**
 * A recovery link, `/auth/recover#t=…` (Identity §4.6, §7 screen 5; Platform §10): the account's email
 * prominently, then Continue, whose POST signs the account out everywhere and sets an enrolment ticket,
 * then a new passkey. Opening the page changes nothing; it can be reopened until a passkey is registered.
 */
export function RecoverPage() {
  const token = useFragmentToken();
  const finish = useFinish();
  const [enrolledEmail, setEnrolledEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lookup = useQuery({
    queryKey: ["recovery", "lookup", token],
    queryFn: () => lookupRecoveryLink(token ?? ""),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const open = useMutation({
    mutationFn: () => openRecoveryLink(token ?? ""),
    meta: { errorToast: false },
    onSuccess: (result) => setEnrolledEmail(result.email),
    onError: (e) => setError(errorCodeOf(e) === "gone" ? copy.invalid : failure(e)),
  });

  if (token === null) {
    return (
      <PublicPage title={copy.title}>
        <Alert>{copy.missing}</Alert>
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
        <Alert>{errorCodeOf(lookup.error) === "gone" ? copy.invalid : failure(lookup.error)}</Alert>
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
  if (enrolledEmail) {
    return (
      <EnrolStep
        title={copy.passkeyTitle}
        description={copy.passkeyDescription(enrolledEmail)}
        button={copy.createPasskey}
        pendingButton={copy.creatingPasskey}
        expiredMessage={copy.ticketExpired}
        onRegistered={finish}
      />
    );
  }
  return (
    <PublicPage title={copy.title}>
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
        <p>{copy.confirm(lookup.data.workspaceName)}</p>
        <p className="text-xl font-semibold break-all">{lookup.data.email}</p>
        <p className="text-sm text-muted">{copy.notYou}</p>
      </div>
      <p>{copy.explain}</p>
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <Button variant="primary" disabled={open.isPending || error !== null} onClick={() => open.mutate()}>
          {open.isPending ? copy.continuing : copy.continue}
        </Button>
      </div>
    </PublicPage>
  );
}

type OwnerField = "email" | "token";

/**
 * Owner recovery, `/recover` (Identity §4.6, §7 screen 5): the `RECOVERY_TOKEN` secret and one owner's
 * email, then a new passkey for that owner. The secret is typed in, never put in a link.
 */
export function OwnerRecoverPage() {
  const finish = useFinish();
  const formRef = useRef<HTMLFormElement>(null);
  const own = messages.ownerRecovery;
  const [values, setValues] = useState<Record<OwnerField, string>>({ email: "", token: "" });
  const [errors, setErrors] = useState<FieldErrors<OwnerField>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [enrolledEmail, setEnrolledEmail] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: recoverOwner,
    meta: { errorToast: false },
    onSuccess: (result) => setEnrolledEmail(result.email),
    onError: (e) => {
      const reason = errorReasonOf(e);
      if (reason === "recovery_token_invalid") {
        setErrors({ token: own.wrongToken });
        requestAnimationFrame(() => focusFirstInvalid(formRef.current));
        return;
      }
      if (reason === "recovery_token_used") return setFormError(own.used);
      if (reason === "owner_not_found") {
        setErrors({ email: own.noOwner });
        requestAnimationFrame(() => focusFirstInvalid(formRef.current));
        return;
      }
      if (errorCodeOf(e) === "not_found") return setFormError(own.notSet);
      setFormError(failure(e));
    },
  });

  if (!supportsPasskeys()) {
    return (
      <PublicPage title={own.title}>
        <Alert>{messages.passkey.unsupported}</Alert>
      </PublicPage>
    );
  }
  if (enrolledEmail) {
    return (
      <EnrolStep
        title={copy.passkeyTitle}
        description={copy.passkeyDescription(enrolledEmail)}
        button={copy.createPasskey}
        pendingButton={copy.creatingPasskey}
        expiredMessage={copy.ticketExpired}
        onRegistered={finish}
      />
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const found: FieldErrors<OwnerField> = {};
    const emailProblem = emailError(values.email);
    const tokenProblem = requiredError(values.token);
    if (emailProblem) found.email = emailProblem;
    if (tokenProblem) found.token = tokenProblem;
    setErrors(found);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    mutation.mutate({ email: values.email.trim(), token: values.token });
  }

  const set = (field: OwnerField) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  return (
    <PublicPage title={own.title} description={own.description}>
      {formError ? <Alert>{formError}</Alert> : null}
      <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label={own.emailLabel}
          type="email"
          value={values.email}
          onChange={(e) => set("email")(e.target.value)}
          error={errors.email}
          required
          autoComplete="email"
        />
        <TextField
          label={own.tokenLabel}
          hint={own.tokenHint}
          type="password"
          value={values.token}
          onChange={(e) => set("token")(e.target.value)}
          error={errors.token}
          required
          autoComplete="off"
          spellCheck={false}
        />
        <div>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? own.submitting : own.submit}
          </Button>
        </div>
      </form>
    </PublicPage>
  );
}
