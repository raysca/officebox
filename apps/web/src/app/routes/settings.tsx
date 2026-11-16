import {
  EMAIL_DRIVER_SECRETS,
  EMAIL_DRIVERS,
  emailProviderSchema,
  type EmailDriverKind,
  type EmailProvider,
  type SettingEntryView,
  type SettingsList,
  type SignInKeySource,
} from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { patchSetting, sendTestEmail, settingsQuery, settingsQueryKey } from "../../lib/api/admin";
import { ApiRequestError, describeApiError, errorReasonOf } from "../../lib/api/client";
import { publicStatusQueryKey } from "../../lib/api/onboarding";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import { messages } from "../messages";
import { Page } from "../Page";
import { LoadFailure } from "./admin";

const copy = messages.settings;

function entry(settings: readonly SettingEntryView[], key: string): SettingEntryView | undefined {
  return settings.find((s) => s.key === key);
}

/**
 * Settings (Admin §6; Platform §7) for M1b: **Email** (owner-only: the driver and sender, never a
 * default domain; provider keys are Worker secrets, named here but never entered), Send test email, and
 * **Sign-in and invitations** (magic links on or off, allowed invitation domains). Controls someone
 * can't change are `aria-disabled` with the reason (Admin §3).
 */
export function SettingsPage() {
  const settings = useQuery(settingsQuery);
  return (
    <Page title={copy.title} description={copy.description}>
      {settings.isPending ? <p role="status">{copy.loading}</p> : null}
      {settings.isError ? <LoadFailure query={settings} /> : null}
      {settings.isSuccess ? (
        <>
          <EmailSection
            provider={entry(settings.data.settings, "email_provider")}
            status={settings.data.email}
            key={JSON.stringify(entry(settings.data.settings, "email_provider")?.value)}
          />
          <SignInSection
            magicLinks={entry(settings.data.settings, "magic_link_enabled")}
            domains={entry(settings.data.settings, "allowed_invite_domains")}
          />
          <SignInKeysSection keys={settings.data.signInKeys} />
        </>
      ) : null}
    </Page>
  );
}

type EmailForm = {
  driver: EmailDriverKind;
  from: string;
  fromName: string;
  region: string;
  host: string;
  port: string;
  security: "starttls" | "tls";
  username: string;
};

function formFrom(value: unknown): EmailForm {
  const parsed = emailProviderSchema.safeParse(value);
  const provider: EmailProvider = parsed.success ? parsed.data : { driver: "none" };
  const base: EmailForm = {
    driver: provider.driver,
    from: "",
    fromName: "",
    region: "",
    host: "",
    port: "587",
    security: "starttls",
    username: "",
  };
  if (provider.driver === "none") return base;
  const out = { ...base, from: provider.from, fromName: provider.fromName ?? "" };
  if (provider.driver === "ses") out.region = provider.region;
  if (provider.driver === "smtp") {
    out.host = provider.host;
    out.port = String(provider.port);
    out.security = provider.security;
    out.username = provider.username;
  }
  return out;
}

function toProvider(form: EmailForm): unknown {
  if (form.driver === "none") return { driver: "none" };
  const sender = { from: form.from.trim(), ...(form.fromName.trim() ? { fromName: form.fromName.trim() } : {}) };
  if (form.driver === "ses") return { driver: "ses", ...sender, region: form.region.trim() };
  if (form.driver === "smtp") {
    return {
      driver: "smtp",
      ...sender,
      host: form.host.trim(),
      port: Number(form.port),
      security: form.security,
      username: form.username.trim(),
    };
  }
  return { driver: form.driver, ...sender };
}

function EmailSection({
  provider,
  status,
}: {
  provider: SettingEntryView | undefined;
  status: { driver: EmailDriverKind; configured: boolean; missing: string[] };
}) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const canChange = provider?.canChange ?? false;
  const [form, setForm] = useState<EmailForm>(() => formFrom(provider?.value));
  const [errors, setErrors] = useState<Partial<Record<keyof EmailForm, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: patchSetting,
    meta: { errorToast: false },
    onSuccess: async () => {
      toastStore.show(copy.saved, "info");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsQueryKey }),
        queryClient.invalidateQueries({ queryKey: publicStatusQueryKey }),
      ]);
    },
    onError: (failure) =>
      setFormError(
        failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : messages.errors.generic,
      ),
  });
  const test = useMutation({
    mutationFn: sendTestEmail,
    meta: { errorToast: false },
    onSuccess: (result) => toastStore.show(copy.testSent(result.to), "info"),
    onError: (failure) => {
      if (errorReasonOf(failure) === "email_not_configured") toastStore.show(copy.testUnavailable, "error");
      else
        toastStore.show(
          failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : messages.errors.generic,
          "error",
        );
    },
  });

  const set = (field: keyof EmailForm) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canChange) return;
    setFormError(null);
    const value = toProvider(form);
    const parsed = emailProviderSchema.safeParse(value);
    if (!parsed.success) {
      const next: Partial<Record<keyof EmailForm, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "from") as keyof EmailForm;
        next[field] = field === "from" ? messages.form.emailInvalid : messages.form.required;
      }
      setErrors(next);
      setFormError(copy.invalid);
      return;
    }
    save.mutate({ key: "email_provider", value: parsed.data });
  }

  const statusText =
    status.driver === "none"
      ? copy.statusOff
      : status.configured
        ? copy.statusOn(copy.drivers[status.driver])
        : copy.statusMissing(status.missing.join(", "));
  const secrets = form.driver === "none" ? [] : EMAIL_DRIVER_SECRETS[form.driver];
  const disabledProps = canChange
    ? {}
    : { "aria-disabled": true as const, "aria-describedby": reasonId, readOnly: true };

  return (
    <section aria-labelledby="email-heading" className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-1">
        <h2 id="email-heading" className="text-lg font-semibold">
          {copy.emailSection}
        </h2>
        <p className="text-sm text-muted">{copy.emailDescription}</p>
      </div>
      <Alert tone={status.driver !== "none" && !status.configured ? "error" : "info"}>{statusText}</Alert>
      {canChange ? null : (
        <p id={reasonId} className="text-sm text-muted">
          {copy.ownerOnly}
        </p>
      )}
      {formError ? <Alert>{formError}</Alert> : null}
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="email-driver" className="text-sm font-medium">
            {copy.driverLabel}
          </label>
          <select
            id="email-driver"
            className="rounded-md border border-border-strong bg-bg px-3 py-2 text-base text-fg"
            value={form.driver}
            aria-disabled={canChange ? undefined : true}
            aria-describedby={canChange ? undefined : reasonId}
            onChange={(e) => {
              if (canChange) set("driver")(e.target.value);
            }}
          >
            {EMAIL_DRIVERS.map((driver) => (
              <option key={driver} value={driver}>
                {copy.drivers[driver]}
              </option>
            ))}
          </select>
        </div>
        {form.driver === "none" ? null : (
          <>
            <TextField
              label={copy.senderLabel}
              hint={copy.senderHint}
              type="email"
              value={form.from}
              onChange={(e) => set("from")(e.target.value)}
              error={errors.from}
              required
              autoComplete="off"
              {...disabledProps}
            />
            <TextField
              label={copy.senderNameLabel}
              value={form.fromName}
              onChange={(e) => set("fromName")(e.target.value)}
              error={errors.fromName}
              maxLength={64}
              {...disabledProps}
            />
            {form.driver === "ses" ? (
              <TextField
                label={copy.regionLabel}
                hint={copy.regionHint}
                value={form.region}
                onChange={(e) => set("region")(e.target.value)}
                error={errors.region}
                required
                {...disabledProps}
              />
            ) : null}
            {form.driver === "smtp" ? (
              <>
                <TextField
                  label={copy.hostLabel}
                  value={form.host}
                  onChange={(e) => set("host")(e.target.value)}
                  error={errors.host}
                  required
                  {...disabledProps}
                />
                <div className="flex flex-col gap-1">
                  <label htmlFor="smtp-port" className="text-sm font-medium">
                    {copy.portLabel}
                  </label>
                  <select
                    id="smtp-port"
                    className="rounded-md border border-border-strong bg-bg px-3 py-2 text-base text-fg"
                    value={form.port}
                    aria-disabled={canChange ? undefined : true}
                    onChange={(e) => {
                      if (canChange) set("port")(e.target.value);
                    }}
                  >
                    {["587", "465", "2525"].map((port) => (
                      <option key={port} value={port}>
                        {port}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="smtp-security" className="text-sm font-medium">
                    {copy.securityLabel}
                  </label>
                  <select
                    id="smtp-security"
                    className="rounded-md border border-border-strong bg-bg px-3 py-2 text-base text-fg"
                    value={form.security}
                    aria-disabled={canChange ? undefined : true}
                    onChange={(e) => {
                      if (canChange) set("security")(e.target.value);
                    }}
                  >
                    <option value="starttls">{copy.securityStarttls}</option>
                    <option value="tls">{copy.securityTls}</option>
                  </select>
                </div>
                <TextField
                  label={copy.usernameLabel}
                  value={form.username}
                  onChange={(e) => set("username")(e.target.value)}
                  error={errors.username}
                  required
                  autoComplete="off"
                  {...disabledProps}
                />
              </>
            ) : null}
            {secrets.length > 0 ? <p className="text-sm text-muted">{copy.secretHint(secrets.join(", "))}</p> : null}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={save.isPending}
            aria-disabled={canChange ? undefined : true}
            aria-describedby={canChange ? undefined : reasonId}
          >
            {save.isPending ? copy.saving : copy.save}
          </Button>
          <Button disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? copy.testing : copy.test}
          </Button>
        </div>
      </form>
    </section>
  );
}

function SignInSection({
  magicLinks,
  domains,
}: {
  magicLinks: SettingEntryView | undefined;
  domains: SettingEntryView | undefined;
}) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(magicLinks?.value === true);
  const [domainText, setDomainText] = useState(
    Array.isArray(domains?.value) ? (domains.value as string[]).join(", ") : "",
  );
  const [domainError, setDomainError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const list = domainText
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d !== "");
      await patchSetting({ key: "magic_link_enabled", value: enabled });
      await patchSetting({ key: "allowed_invite_domains", value: list });
    },
    meta: { errorToast: false },
    onSuccess: async () => {
      toastStore.show(copy.saved, "info");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsQueryKey }),
        queryClient.invalidateQueries({ queryKey: publicStatusQueryKey }),
      ]);
    },
    onError: (failure) => {
      if (
        failure instanceof ApiRequestError &&
        failure.detail.kind === "api" &&
        failure.detail.error.code === "validation_failed"
      ) {
        setDomainError(copy.invalid);
        return;
      }
      setFormError(
        failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : messages.errors.generic,
      );
    },
  });
  return (
    <section aria-labelledby="signin-heading" className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <h2 id="signin-heading" className="text-lg font-semibold">
        {copy.signInSection}
      </h2>
      {formError ? <Alert>{formError}</Alert> : null}
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setFormError(null);
          setDomainError(null);
          save.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              aria-describedby="magic-links-hint"
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {copy.magicLinksLabel}
          </label>
          <p id="magic-links-hint" className="text-sm text-muted">
            {copy.magicLinksHint}
          </p>
        </div>
        <TextField
          label={copy.domainsLabel}
          hint={copy.domainsHint}
          value={domainText}
          onChange={(e) => {
            setDomainText(e.target.value);
            setDomainError(null);
          }}
          error={domainError}
          autoComplete="off"
          spellCheck={false}
        />
        <div>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? copy.saving : copy.saveSignIn}
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * Where each sign-in key comes from (Platform §16, M1b-1): read-only, never a value. Production
 * workspaces should use Worker secrets; setting one later signs everyone out or invalidates links.
 */
function SignInKeysSection({ keys }: { keys: SettingsList["signInKeys"] }) {
  const rows: [string, SignInKeySource][] = [
    ["BETTER_AUTH_SECRET", keys.betterAuthSecret],
    ["TOKEN_HASH_KEY", keys.tokenHashKey],
  ];
  return (
    <section aria-labelledby="keys-heading" className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <h2 id="keys-heading" className="text-lg font-semibold">
        {copy.keysSection}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([name, source]) => (
          <div key={name} className="contents">
            <dt className="font-mono">{name}</dt>
            <dd>{copy.keySources[source]}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted">{copy.keysNote}</p>
    </section>
  );
}
