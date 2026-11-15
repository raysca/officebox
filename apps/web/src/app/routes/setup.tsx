import { isWorkersDevHost, type SetupEnrolment } from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { ApiRequestError, describeApiError, errorCodeOf } from "../../lib/api/client";
import {
  claimSetup,
  meQueryKey,
  registerPasskey,
  resumeSetup,
  setupStatusQuery,
  setupStatusQueryKey,
} from "../../lib/api/identity";
import { supportsPasskeys } from "../../lib/api/webauthn";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Link } from "../../lib/ui/Link";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import {
  describePasskeyFailure,
  emailError,
  focusFirstInvalid,
  handleError,
  nameError,
  requiredError,
  serverInvalidFields,
  suggestHandle,
  type FieldErrors,
} from "../forms";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";

type Field = "token" | "workspaceName" | "ownerName" | "ownerHandle" | "ownerEmail";

const copy = messages.setup;

function validate(values: Record<Field, string>): FieldErrors<Field> {
  const errors: FieldErrors<Field> = {};
  const checks: Record<Field, string | null> = {
    token: requiredError(values.token),
    workspaceName: nameError(values.workspaceName),
    ownerName: nameError(values.ownerName),
    ownerHandle: handleError(values.ownerHandle),
    ownerEmail: emailError(values.ownerEmail),
  };
  for (const [field, error] of Object.entries(checks) as [Field, string | null][]) if (error) errors[field] = error;
  return errors;
}

function onWorkersDev(): boolean {
  return isWorkersDevHost(window.location.host);
}

/**
 * First-run setup (Identity §4.1, §7 screen 1): the WebAuthn preflight, the setup token and the
 * workspace and owner (the claim), then the owner's passkey, then the second-passkey recommendation.
 * A claim left before the passkey is resumed with the same token, on any device.
 */
export function SetupPage() {
  const status = useQuery(setupStatusQuery);
  const [enrolment, setEnrolment] = useState<SetupEnrolment | null>(null);
  const [done, setDone] = useState(false);

  if (status.isPending) {
    return (
      <PublicPage title={copy.title}>
        <p role="status">{copy.loading}</p>
      </PublicPage>
    );
  }
  if (status.isError && !enrolment && !done) {
    const complete = errorCodeOf(status.error) === "not_found";
    return (
      <PublicPage title={copy.title}>
        <Alert tone={complete ? "info" : "error"}>{complete ? copy.alreadyDone : copy.failed}</Alert>
        {complete ? (
          <p>
            <Link to="/sign-in">{messages.signIn.title}</Link>
          </p>
        ) : null}
      </PublicPage>
    );
  }
  // WebAuthn preflight: stop before anything is submitted (Identity §4.1).
  if (!supportsPasskeys()) {
    return (
      <PublicPage title={copy.title}>
        <Alert>{messages.passkey.unsupported}</Alert>
      </PublicPage>
    );
  }
  if (done) return <SecondPasskeyStep />;
  if (enrolment) {
    return (
      <PasskeyStep
        enrolment={enrolment}
        onDone={() => setDone(true)}
        onExpired={() => {
          setEnrolment(null);
          void status.refetch();
        }}
      />
    );
  }
  const data = status.data;
  if (data?.claimed) return <ResumeForm onEnrolled={setEnrolment} />;
  return <ClaimForm tokenSource={data?.tokenSource ?? "generated"} onEnrolled={setEnrolment} />;
}

function ClaimForm({
  tokenSource,
  onEnrolled,
}: {
  tokenSource: "secret" | "generated";
  onEnrolled: (enrolment: SetupEnrolment) => void;
}) {
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<Field, string>>({
    token: "",
    workspaceName: "",
    ownerName: "",
    ownerHandle: "",
    ownerEmail: "",
  });
  const [handleEdited, setHandleEdited] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: claimSetup,
    meta: { errorToast: false },
    onSuccess: onEnrolled,
    onError: async (error) => {
      const code = errorCodeOf(error);
      if (code === "not_found") return setFormError(copy.alreadyDone);
      if (code === "unavailable") return void (await navigate({ to: "/not-configured" }));
      if (code === "forbidden") {
        setErrors({ token: copy.tokenInvalid });
        requestAnimationFrame(() => focusFirstInvalid(formRef.current));
        return;
      }
      const invalid = serverInvalidFields(error);
      if (invalid.length > 0) {
        const local = validate(values);
        const next: FieldErrors<Field> = {};
        for (const field of invalid as Field[]) next[field] = local[field] ?? messages.errors.byCode.validation_failed;
        setErrors(next);
        requestAnimationFrame(() => focusFirstInvalid(formRef.current));
        return;
      }
      setFormError(
        error instanceof ApiRequestError ? describeApiError(error.detail, "mutation") : messages.errors.generic,
      );
    },
  });

  const set = (field: Field) => (value: string) => {
    setValues((current) => {
      const next = { ...current, [field]: value };
      if (field === "ownerName" && !handleEdited) next.ownerHandle = suggestHandle(value);
      return next;
    });
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    mutation.mutate({ ...values });
  }

  return (
    <PublicPage title={copy.title} description={copy.description}>
      {formError ? <Alert>{formError}</Alert> : null}
      <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-6">
        <TextField
          label={copy.tokenLabel}
          hint={tokenSource === "secret" ? copy.tokenHintSecret : copy.tokenHintGenerated}
          value={values.token}
          onChange={(e) => set("token")(e.target.value)}
          error={errors.token}
          required
          autoComplete="off"
          spellCheck={false}
        />
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-lg font-semibold">{copy.workspaceSection}</legend>
          <TextField
            label={copy.workspaceNameLabel}
            value={values.workspaceName}
            onChange={(e) => set("workspaceName")(e.target.value)}
            error={errors.workspaceName}
            required
            autoComplete="organization"
          />
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-lg font-semibold">{copy.ownerSection}</legend>
          <TextField
            label={copy.ownerNameLabel}
            value={values.ownerName}
            onChange={(e) => set("ownerName")(e.target.value)}
            error={errors.ownerName}
            required
            autoComplete="name"
          />
          <TextField
            label={copy.ownerHandleLabel}
            hint={copy.ownerHandleHint}
            value={values.ownerHandle}
            onChange={(e) => {
              setHandleEdited(true);
              set("ownerHandle")(e.target.value);
            }}
            error={errors.ownerHandle}
            required
            autoComplete="nickname"
            autoCapitalize="none"
            spellCheck={false}
          />
          <TextField
            label={copy.ownerEmailLabel}
            type="email"
            value={values.ownerEmail}
            onChange={(e) => set("ownerEmail")(e.target.value)}
            error={errors.ownerEmail}
            required
            autoComplete="email"
          />
        </fieldset>
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {mutation.isPending ? copy.submitting : copy.submit}
        </Button>
      </form>
    </PublicPage>
  );
}

function ResumeForm({ onEnrolled }: { onEnrolled: (enrolment: SetupEnrolment) => void }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: resumeSetup,
    meta: { errorToast: false },
    onSuccess: onEnrolled,
    onError: (failure) => {
      const code = errorCodeOf(failure);
      if (code === "forbidden") setError(copy.tokenInvalid);
      else if (code === "gone") setFormError(copy.resumeGone);
      else if (code === "conflict") {
        // The earlier claim never got its owner and was released: back to the full setup form.
        toastStore.show(copy.resumeReset, "info");
        void queryClient.invalidateQueries({ queryKey: setupStatusQueryKey });
      } else
        setFormError(
          failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : messages.errors.generic,
        );
    },
  });
  return (
    <PublicPage title={copy.claimedTitle} description={copy.claimedDescription}>
      {formError ? <Alert>{formError}</Alert> : null}
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          setFormError(null);
          const missing = requiredError(token);
          setError(missing);
          if (!missing) mutation.mutate(token);
        }}
      >
        <TextField
          label={copy.tokenLabel}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setError(null);
          }}
          error={error}
          required
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {mutation.isPending ? copy.resuming : copy.resume}
        </Button>
      </form>
    </PublicPage>
  );
}

function PasskeyStep({
  enrolment,
  onDone,
  onExpired,
}: {
  enrolment: SetupEnrolment;
  onDone: () => void;
  onExpired: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: registerPasskey,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      if (result.ok) {
        await queryClient.invalidateQueries({ queryKey: meQueryKey });
        onDone();
        return;
      }
      const failure = result.error;
      if (
        failure.kind === "api" &&
        failure.error.kind === "api" &&
        failure.error.error.reason?.startsWith("ENROLMENT_TICKET")
      ) {
        toastStore.show(copy.ticketExpired, "error");
        onExpired();
        return;
      }
      setError(describePasskeyFailure(failure));
    },
  });
  return (
    <PublicPage title={copy.passkeyTitle} description={copy.passkeyDescription(enrolment.ownerEmail)}>
      {onWorkersDev() ? <Alert tone="info">{messages.passkey.workersDevWarning}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <Button
          variant="primary"
          disabled={mutation.isPending}
          onClick={() => {
            setError(null);
            mutation.mutate();
          }}
        >
          {mutation.isPending ? copy.creatingPasskey : copy.createPasskey}
        </Button>
      </div>
    </PublicPage>
  );
}

function SecondPasskeyStep() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: registerPasskey,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(describePasskeyFailure(result.error));
        return;
      }
      toastStore.show(messages.passkeys.addedToast, "info");
      await queryClient.invalidateQueries({ queryKey: meQueryKey });
      await navigate({ to: "/", replace: true });
    },
  });
  return (
    <PublicPage title={copy.secondTitle} description={copy.secondDescription}>
      {onWorkersDev() ? (
        <section aria-label={copy.checklistTitle}>
          <Alert tone="info">
            <span className="flex flex-col gap-1">
              <strong>{copy.checklistTitle}</strong>
              <span>{copy.workersDevNoEmail}</span>
            </span>
          </Alert>
        </section>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={mutation.isPending}
          onClick={() => {
            setError(null);
            mutation.mutate();
          }}
        >
          {mutation.isPending ? messages.passkeys.adding : copy.addSecond}
        </Button>
        <Button onClick={() => void navigate({ to: "/", replace: true })}>{copy.skipSecond}</Button>
      </div>
    </PublicPage>
  );
}
