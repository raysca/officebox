import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { ApiRequestError, describeApiError, errorCodeOf } from "../../lib/api/client";
import { completeSetup, setupStatusQuery } from "../../lib/api/identity";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Link } from "../../lib/ui/Link";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import {
  emailError,
  focusFirstInvalid,
  handleError,
  nameError,
  newPasswordError,
  requiredError,
  serverInvalidFields,
  suggestHandle,
  type FieldErrors,
} from "../forms";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";

type Field = "token" | "workspaceName" | "ownerName" | "ownerHandle" | "ownerEmail" | "password";

const copy = messages.setup;

function validate(values: Record<Field, string>): FieldErrors<Field> {
  const errors: FieldErrors<Field> = {};
  const checks: Record<Field, string | null> = {
    token: requiredError(values.token),
    workspaceName: nameError(values.workspaceName),
    ownerName: nameError(values.ownerName),
    ownerHandle: handleError(values.ownerHandle),
    ownerEmail: emailError(values.ownerEmail),
    password: newPasswordError(values.password),
  };
  for (const [field, error] of Object.entries(checks) as [Field, string | null][]) if (error) errors[field] = error;
  return errors;
}

/**
 * First-run setup (Identity §4.1, §7 screen 1): the setup token, then the workspace and the owner.
 * Once the workspace exists `/api/setup` is 404 and this page points to sign-in instead.
 */
export function SetupPage() {
  const status = useQuery(setupStatusQuery);
  if (status.isPending) {
    return (
      <PublicPage title={copy.title}>
        <p role="status">{copy.loading}</p>
      </PublicPage>
    );
  }
  if (status.isError) {
    const done = errorCodeOf(status.error) === "not_found";
    return (
      <PublicPage title={copy.title}>
        <Alert tone={done ? "info" : "error"}>{done ? copy.alreadyDone : copy.failed}</Alert>
        {done ? (
          <p>
            <Link to="/sign-in">{messages.signIn.title}</Link>
          </p>
        ) : null}
      </PublicPage>
    );
  }
  return <SetupForm tokenSource={status.data.tokenSource} />;
}

function SetupForm({ tokenSource }: { tokenSource: "secret" | "generated" }) {
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<Field, string>>({
    token: "",
    workspaceName: "",
    ownerName: "",
    ownerHandle: "",
    ownerEmail: "",
    password: "",
  });
  const [handleEdited, setHandleEdited] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: completeSetup,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      toastStore.show(copy.done, "info");
      await navigate({ to: "/sign-in", search: { email: result.ownerEmail } });
    },
    onError: (error) => {
      const code = errorCodeOf(error);
      if (code === "not_found") {
        setFormError(copy.alreadyDone);
        return;
      }
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
          <TextField
            label={copy.passwordLabel}
            hint={copy.passwordHint}
            type="password"
            value={values.password}
            onChange={(e) => set("password")(e.target.value)}
            error={errors.password}
            required
            autoComplete="new-password"
          />
        </fieldset>
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {mutation.isPending ? copy.submitting : copy.submit}
        </Button>
      </form>
    </PublicPage>
  );
}
