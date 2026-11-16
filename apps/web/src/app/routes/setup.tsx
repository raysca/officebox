import {
  isWorkersDevHost,
  type SetupEnrolment,
  type SetupService,
  type SetupServiceId,
  type SetupServiceProblem,
  type SetupStatus,
} from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type FormEvent, type Ref } from "react";
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
import { VisuallyHidden } from "../../lib/ui/VisuallyHidden";
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

function validate(values: Record<Field, string>, tokenNeeded = true): FieldErrors<Field> {
  const errors: FieldErrors<Field> = {};
  const checks: Record<Field, string | null> = {
    token: tokenNeeded ? requiredError(values.token) : null,
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
 * First-run setup (Identity §4.1, §7 screen 1): the required-services checklist (M1b-1), the WebAuthn
 * preflight, the setup token (none needed while the open claim window lasts, M1b-1) and the workspace
 * and owner (the claim), then the owner's passkey, then the second-passkey recommendation. A claim
 * left before the passkey is resumed with the same token, or the setup resume code an open-window
 * claim showed once, on any device.
 */
export function SetupPage() {
  const status = useQuery(setupStatusQuery);
  const [enrolment, setEnrolment] = useState<SetupEnrolment | null>(null);
  const [done, setDone] = useState(false);
  const failing = status.data?.services.some((service) => !service.ok) ?? false;
  const wasFailing = useRef(false);
  const formHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // The checklist gave way to the setup form: move focus to its heading, so keyboard and screen
    // reader users land on the new page rather than on a button that's gone.
    if (wasFailing.current && !failing) formHeading.current?.focus();
    wasFailing.current = failing;
  }, [failing]);

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
  // Nothing else is offered until every required service passes (M1b-1).
  if (data && failing) {
    return (
      <ServicesChecklist
        services={data.services}
        checking={status.isFetching}
        onRecheck={() => void status.refetch()}
      />
    );
  }
  if (data?.claimed)
    return <ResumeForm open={data.mode === "open"} onEnrolled={setEnrolment} headingRef={formHeading} />;
  return (
    <ClaimForm
      headingRef={formHeading}
      tokenSource={data?.tokenSource ?? "generated"}
      openUntil={data?.mode === "open" ? (data.openUntil ?? null) : null}
      // The server's clock minus the browser's when the status arrived: the countdown follows the
      // server, so a fast browser clock doesn't end the window early.
      skewMs={data?.now !== undefined ? data.now - status.dataUpdatedAt : 0}
      onEnrolled={setEnrolment}
      onServicesFailing={() => void status.refetch()}
    />
  );
}

function serviceFix(id: SetupServiceId, problem: SetupServiceProblem | undefined): string {
  const fixes = copy.serviceFixes;
  switch (id) {
    case "d1":
      return fixes.d1[problem ?? "unreachable"];
    case "durable_objects":
    case "queues":
    case "r2":
      return fixes[id];
    case "better_auth_secret":
    case "token_hash_key":
      return problem === "invalid_secret" ? fixes[id].invalid_secret : fixes[id].unreachable;
  }
}

/** The required-services checklist (Identity §4.1): a tick or a plain fix for each service. */
function ServicesChecklist({
  services,
  checking,
  onRecheck,
}: {
  services: SetupStatus["services"];
  checking: boolean;
  onRecheck: () => void;
}) {
  const failingCount = services.filter((service) => !service.ok).length;
  // The live region mounts empty and gets its text afterwards, so screen readers announce it (a
  // region that arrives with its text already in it often isn't read).
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    // In a task after the commit, so the empty region is in the page before its text arrives.
    const timer = setTimeout(
      () => setAnnouncement(checking ? copy.servicesRechecking : copy.servicesSummary(failingCount)),
      0,
    );
    return () => clearTimeout(timer);
  }, [checking, failingCount]);
  return (
    <PublicPage title={copy.servicesTitle} description={copy.servicesDescription}>
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
      <ul aria-label={copy.servicesListLabel} className="flex flex-col gap-3">
        {services.map((service: SetupService) => (
          <li
            key={service.id}
            className="flex gap-3 rounded-md border border-border-strong px-3 py-2 text-sm"
            data-service={service.id}
          >
            <span aria-hidden="true" className={service.ok ? "text-fg" : "text-danger"}>
              {service.ok ? "✓" : "✗"}
            </span>
            <span className="flex flex-col gap-1">
              <strong>{copy.serviceNames[service.id]}</strong>
              <span>
                {service.ok ? null : <VisuallyHidden>{copy.servicesNeedsAttention} </VisuallyHidden>}
                {service.ok ? copy.servicesOk : serviceFix(service.id, service.problem)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div>
        {/* Stays focusable while checking (aria-busy), so focus isn't lost to the page. */}
        <Button variant="primary" aria-busy={checking} onClick={() => (checking ? undefined : onRecheck())}>
          {checking ? copy.servicesRechecking : copy.servicesRecheck}
        </Button>
      </div>
    </PublicPage>
  );
}

const MINUTE = 60_000;

/** Whole minutes left, rounded up, so "1 minute" shows until the window really ends. */
function minutesLeft(openUntil: number, now: number): number {
  return Math.max(0, Math.ceil((openUntil - now) / MINUTE));
}

/**
 * The open-window notice (Identity §4.1): the time left as text that changes once a minute, and a
 * separate polite announcement only at 10 minutes and at 1 minute left, never on every update. Calls
 * `onClosed` when the window ends, so the page can ask for the token.
 */
function OpenWindowNotice({
  openUntil,
  skewMs,
  onClosed,
}: {
  openUntil: number;
  /** Server clock minus browser clock (ms). */
  skewMs: number;
  onClosed: () => void;
}) {
  const serverNow = useCallback(() => Date.now() + skewMs, [skewMs]);
  const [now, setNow] = useState(serverNow);
  const [announcement, setAnnouncement] = useState("");
  const left = minutesLeft(openUntil, now);
  const announced = useRef<number | null>(null);

  useEffect(() => {
    if (left <= 0) {
      onClosed();
      return;
    }
    // Wake when the rounded-up minute changes (or the window ends), not on a fixed tick.
    const untilChange = (openUntil - serverNow()) % MINUTE || MINUTE;
    const timer = setTimeout(() => setNow(serverNow()), untilChange + 50);
    return () => clearTimeout(timer);
  }, [left, openUntil, onClosed, serverNow]);

  useEffect(() => {
    if ((left === 10 || left === 1) && announced.current !== left) {
      announced.current = left;
      setAnnouncement(copy.openAnnouncement(left));
    }
  }, [left]);

  const until = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(openUntil);
  return (
    <>
      <div className="rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg">
        <p>{copy.openNotice(until, left)}</p>
      </div>
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
    </>
  );
}

function ClaimForm({
  tokenSource,
  openUntil,
  skewMs,
  onEnrolled,
  onServicesFailing,
  headingRef,
}: {
  tokenSource: "secret" | "generated";
  /** End of the open claim window, or null outside it. */
  openUntil: number | null;
  skewMs: number;
  onEnrolled: (enrolment: SetupEnrolment) => void;
  onServicesFailing: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  // Starts open while the window lasts; switches to the token form for good once it ends.
  const [open, setOpen] = useState(openUntil !== null);
  const [closedNotice, setClosedNotice] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  useEffect(() => {
    if (focusToken > 0) focusFirstInvalid(formRef.current);
  }, [focusToken]);
  const closeWindow = useCallback(() => {
    setOpen(false);
    setClosedNotice(true);
  }, []);
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
      if (code === "setup_services_failing") return onServicesFailing();
      if (code === "setup_token_required") {
        // The window ended while the form was open: keep what was typed and ask for the token.
        closeWindow();
        setErrors({ token: copy.windowClosed });
        // After the re-render that relabels the field (an effect, not a frame callback, so it runs once
        // the new form is in the DOM).
        setFocusToken((n) => n + 1);
        return;
      }
      if (code === "forbidden") {
        setErrors({ token: copy.tokenInvalid });
        requestAnimationFrame(() => focusFirstInvalid(formRef.current));
        return;
      }
      const invalid = serverInvalidFields(error);
      if (invalid.length > 0) {
        const local = validate(values, !open);
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
    const found = validate(values, !open);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    const { token, ...rest } = values;
    // Inside the window an empty token is left out: an open-mode claim (M1b-1).
    mutation.mutate(token.trim() === "" ? rest : { ...rest, token });
  }

  return (
    <PublicPage title={copy.title} description={copy.description} headingRef={headingRef}>
      {open && openUntil !== null ? (
        <OpenWindowNotice openUntil={openUntil} skewMs={skewMs} onClosed={closeWindow} />
      ) : null}
      {closedNotice && !errors.token ? <Alert tone="info">{copy.windowClosed}</Alert> : null}
      {formError ? <Alert>{formError}</Alert> : null}
      <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-6">
        <TextField
          label={open ? copy.tokenLabelOptional : copy.tokenLabel}
          hint={open ? copy.tokenHintOpen : tokenSource === "secret" ? copy.tokenHintSecret : copy.tokenHintGenerated}
          value={values.token}
          onChange={(e) => set("token")(e.target.value)}
          error={errors.token}
          required={!open}
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

function ResumeForm({
  open,
  onEnrolled,
  headingRef,
}: {
  open: boolean;
  onEnrolled: (enrolment: SetupEnrolment) => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
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
    <PublicPage
      title={copy.claimedTitle}
      description={open ? copy.claimedDescriptionOpen : copy.claimedDescription}
      headingRef={headingRef}
    >
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
          label={open ? copy.resumeTokenLabel : copy.tokenLabel}
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
      {enrolment.resumeCode ? <ResumeCode code={enrolment.resumeCode} /> : null}
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

/** The setup resume code, shown once after an open-window claim (Identity §2, M1b-1). */
function ResumeCode({ code }: { code: string }) {
  const id = "setup-resume-code";
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2 rounded-md border border-border-strong p-3">
      <h2 id={`${id}-title`} className="text-base font-semibold">
        {copy.resumeCodeTitle}
      </h2>
      <p className="text-sm">{copy.resumeCodeDescription}</p>
      <label htmlFor={id} className="text-sm font-medium">
        {copy.resumeCodeLabel}
      </label>
      <input
        id={id}
        readOnly
        value={code}
        spellCheck={false}
        className="rounded-md border border-border-strong bg-bg px-3 py-2 font-mono text-sm text-fg"
        onFocus={(event) => event.currentTarget.select()}
      />
    </section>
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
