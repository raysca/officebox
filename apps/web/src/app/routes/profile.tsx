import {
  COUNTRY_CODES,
  isSingleEmoji,
  MAX_STATUS_TEXT_LENGTH,
  normaliseHandle,
  WEEKDAYS,
  type MemberStatus,
  type MyProfile,
  type Weekday,
} from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, describeApiError, errorReasonOf } from "../../lib/api/client";
import { meQueryKey } from "../../lib/api/identity";
import {
  checkHandle,
  clearStatus,
  directoryQueryKey,
  myProfileQuery,
  myProfileQueryKey,
  removeAvatar,
  setStatus,
  updateProfile,
  uploadAvatar,
  type ProfileEdit,
} from "../../lib/api/profile";
import { squareAvatar } from "../../lib/avatar-image";
import {
  browserTimeZone,
  clearAfterTime,
  countryName,
  dayName,
  suggestedRegion,
  timeZoneOptions,
  type ClearAfter,
} from "../../lib/profile-format";
import { Alert } from "../../lib/ui/Alert";
import { Avatar } from "../../lib/ui/Avatar";
import { Button } from "../../lib/ui/Button";
import { Link } from "../../lib/ui/Link";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import { focusFirstInvalid, handleError, nameError, serverInvalidFields, type FieldErrors } from "../forms";
import { messages } from "../messages";
import { Page } from "../Page";

const copy = messages.profile;
const selectClass = "rounded-md border border-border-strong bg-bg px-3 py-2 text-base text-fg";
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** `?welcome=1`: the profile setup step after accepting an invitation (Identity §4.3 step 2). */
export const profileSearchSchema = z.object({
  welcome: z.coerce.boolean().optional().catch(undefined),
});

/**
 * Profile and status (Identity §4.7, §4.8, §7 screen 6; M1d): photo, status (emoji, text, clear after),
 * the profile fields, @handle, time zone, region and working hours. Each section saves on its own.
 *
 * With `welcome` it is also the **profile setup step** after accepting an invitation (Identity §4.3):
 * a welcome note with a way to skip, and the time zone pre-filled from the browser while the member
 * hasn't finished setup. Saving records `onboarded_at` and goes Home.
 */
export function ProfilePage({ welcome = false }: { welcome?: boolean }) {
  const profile = useQuery(myProfileQuery);
  return (
    <Page title={copy.title} description={copy.description}>
      {welcome ? (
        <Alert tone="info" className="flex flex-wrap items-center justify-between gap-2">
          <span>{copy.welcome}</span>
          <Link to="/">{copy.skip}</Link>
        </Alert>
      ) : null}
      {profile.isPending ? <p role="status">{copy.loading}</p> : null}
      {profile.isError ? (
        <Alert>
          <span>{copy.failed} </span>
          <button type="button" className="underline underline-offset-2" onClick={() => void profile.refetch()}>
            {copy.retry}
          </button>
        </Alert>
      ) : null}
      {profile.data ? (
        <>
          <PhotoSection profile={profile.data} />
          <StatusSection profile={profile.data} />
          {/* Remounted when the saved profile changes, so the form starts from what's stored. */}
          <DetailsForm key={profile.dataUpdatedAt} profile={profile.data} welcome={welcome} />
        </>
      ) : null}
    </Page>
  );
}

function useRefreshProfile() {
  const queryClient = useQueryClient();
  return async (next?: MyProfile) => {
    if (next) queryClient.setQueryData(myProfileQueryKey, next);
    await Promise.all([
      next ? Promise.resolve() : queryClient.invalidateQueries({ queryKey: myProfileQueryKey }),
      queryClient.invalidateQueries({ queryKey: meQueryKey }),
      queryClient.invalidateQueries({ queryKey: directoryQueryKey }),
      queryClient.invalidateQueries({ queryKey: ["members", "profile"] }),
    ]);
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 border-t border-border pt-6">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ---- Photo -----------------------------------------------------------------------------------------

function PhotoSection({ profile }: { profile: MyProfile }) {
  const refresh = useRefreshProfile();
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    meta: { errorToast: false },
    mutationFn: async (file: File) => {
      const square = await squareAvatar(file);
      if (!square) throw new Error("unreadable");
      return uploadAvatar(square.blob, square.type);
    },
    onSuccess: async () => {
      setError(null);
      toastStore.show(copy.photoSaved, "info");
      await refresh();
    },
    onError: (failure) => {
      setError(
        failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : copy.photoUnreadable,
      );
    },
    onSettled: () => {
      if (inputRef.current) inputRef.current.value = "";
    },
  });
  const remove = useMutation({
    mutationFn: removeAvatar,
    onSuccess: async () => {
      toastStore.show(copy.photoRemoved, "info");
      await refresh();
    },
  });

  return (
    <Section title={copy.photoTitle}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Avatar name={profile.displayName} url={profile.avatarUrl} size="lg" />
        <div className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-sm font-medium">
            {copy.photoUpload}
          </label>
          <p id={hintId} className="text-sm text-muted">
            {copy.photoHint}
          </p>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-describedby={hintId}
            disabled={upload.isPending}
            className="text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-bg file:px-3 file:py-1.5 file:text-fg"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
                setError(copy.photoType);
                event.target.value = "";
                return;
              }
              upload.mutate(file);
            }}
          />
          {upload.isPending ? <p role="status">{copy.photoUploading}</p> : null}
          {error ? <Alert>{error}</Alert> : null}
          {profile.avatarUrl ? (
            <div>
              <Button onClick={() => remove.mutate()} disabled={remove.isPending}>
                {copy.photoRemove}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

// ---- Status ----------------------------------------------------------------------------------------

function describeStatus(status: MemberStatus): string {
  const text = [status.emoji, status.text].filter(Boolean).join(" ");
  return status.expiresAt ? `${text} (${copy.statusUntil(timeFormat.format(new Date(status.expiresAt)))})` : text;
}

function StatusSection({ profile }: { profile: MyProfile }) {
  const refresh = useRefreshProfile();
  const [emoji, setEmoji] = useState(profile.status?.emoji ?? "");
  const [text, setText] = useState(profile.status?.text ?? "");
  const [clearAfter, setClearAfter] = useState<ClearAfter>("never");
  const [errors, setErrors] = useState<FieldErrors<"emoji">>({});
  const [formError, setFormError] = useState<string | null>(null);
  const clearAfterId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  const save = useMutation({
    meta: { errorToast: false },
    mutationFn: setStatus,
    onSuccess: async () => {
      setFormError(null);
      toastStore.show(copy.statusSaved, "info");
      await refresh();
    },
    onError: (failure) => setFormError(describeFailure(failure)),
  });
  const clear = useMutation({
    mutationFn: clearStatus,
    onSuccess: async () => {
      setEmoji("");
      setText("");
      setClearAfter("never");
      toastStore.show(copy.statusCleared, "info");
      await refresh();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = emoji.trim();
    const next: FieldErrors<"emoji"> =
      trimmed !== "" && !isSingleEmoji(trimmed) ? { emoji: copy.statusEmojiInvalid } : {};
    setErrors(next);
    if (next.emoji) {
      queueMicrotask(() => focusFirstInvalid(formRef.current));
      return;
    }
    if (trimmed === "" && text.trim() === "") {
      clear.mutate();
      return;
    }
    save.mutate({
      emoji: trimmed === "" ? null : trimmed,
      text: text.trim() === "" ? null : text.trim(),
      expiresAt: clearAfterTime(clearAfter, new Date()),
    });
  }

  return (
    <Section title={copy.statusTitle}>
      <p className="text-sm">
        <span className="font-medium">{copy.statusCurrent}: </span>
        <span data-testid="current-status">{profile.status ? describeStatus(profile.status) : copy.statusNone}</span>
      </p>
      <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        {formError ? <Alert>{formError}</Alert> : null}
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <TextField
            label={copy.statusEmoji}
            hint={copy.statusEmojiHint}
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            error={errors.emoji}
            maxLength={32}
            autoComplete="off"
          />
          <TextField
            label={copy.statusText}
            hint={copy.statusTextHint}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_STATUS_TEXT_LENGTH}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={clearAfterId} className="text-sm font-medium">
            {copy.statusClearAfter}
          </label>
          <select
            id={clearAfterId}
            className={`${selectClass} sm:max-w-xs`}
            value={clearAfter}
            onChange={(e) => setClearAfter(e.target.value as ClearAfter)}
          >
            {(Object.keys(copy.clearAfter) as ClearAfter[]).map((choice) => (
              <option key={choice} value={choice}>
                {copy.clearAfter[choice]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {copy.statusSave}
          </Button>
          {profile.status ? (
            <Button onClick={() => clear.mutate()} disabled={clear.isPending}>
              {copy.statusClear}
            </Button>
          ) : null}
        </div>
      </form>
    </Section>
  );
}

// ---- Details, time and place ---------------------------------------------------------------------

type DetailField = "displayName" | "handle" | "timezone" | "region" | "workingHours";

interface DayState {
  on: boolean;
  start: string;
  end: string;
}

function describeFailure(failure: unknown): string {
  return failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : messages.errors.generic;
}

function handleProblem(reason: string | undefined): string | null {
  switch (reason) {
    case "handle_taken":
      return copy.handleTaken;
    case "handle_held":
      return copy.handleHeld;
    case "handle_reserved":
      return copy.handleReserved;
    case "handle_invalid":
      return messages.form.handleInvalid;
    default:
      return null;
  }
}

function DetailsForm({ profile, welcome }: { profile: MyProfile; welcome: boolean }) {
  const refresh = useRefreshProfile();
  const navigate = useNavigate();
  // Until profile setup is done, an untouched UTC zone is replaced by this device's (Identity §4.3).
  const settingUp = profile.onboardedAt === null;
  const formRef = useRef<HTMLFormElement>(null);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [handle, setHandle] = useState(profile.handle ?? "");
  const [handleNote, setHandleNote] = useState<string | null>(null);
  const [pronouns, setPronouns] = useState(profile.pronouns ?? "");
  const [jobTitle, setJobTitle] = useState(profile.jobTitle ?? "");
  const [team, setTeam] = useState(profile.team ?? "");
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [location, setLocation] = useState(profile.location ?? "");
  const [timezone, setTimezone] = useState(() =>
    settingUp && profile.timezone === "UTC" ? (browserTimeZone() ?? profile.timezone) : profile.timezone,
  );
  // The region is suggested only during profile setup; once set up, a cleared region stays cleared.
  const [country, setCountry] = useState(
    () => profile.region?.split("-")[0] ?? (settingUp ? suggestedRegion(navigator.languages) : null) ?? "",
  );
  const [subdivision, setSubdivision] = useState(profile.region?.split("-")[1] ?? "");
  const [days, setDays] = useState<Record<Weekday, DayState>>(() => {
    const entries = WEEKDAYS.map((day) => {
      const first = profile.workingHours[day][0];
      return [day, { on: first !== undefined, start: first?.[0] ?? "09:00", end: first?.[1] ?? "17:00" }] as const;
    });
    return Object.fromEntries(entries) as Record<Weekday, DayState>;
  });
  const [hoursTouched, setHoursTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<DetailField>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const ids = { tz: useId(), country: useId(), hoursHint: useId() };
  const zones = useMemo(() => timeZoneOptions(profile.timezone), [profile.timezone]);
  const countries = useMemo(
    () =>
      [...COUNTRY_CODES]
        .map((code) => ({ code, name: countryName(code) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );
  const deviceZone = browserTimeZone();

  const save = useMutation({
    meta: { errorToast: false },
    mutationFn: updateProfile,
    onSuccess: async (next) => {
      setFormError(null);
      toastStore.show(copy.saved, "info");
      await refresh(next);
      if (welcome) await navigate({ to: "/", replace: true });
    },
    onError: (failure) => {
      const handleMessage = handleProblem(errorReasonOf(failure));
      if (handleMessage) {
        setErrors({ handle: handleMessage });
        queueMicrotask(() => focusFirstInvalid(formRef.current));
        return;
      }
      const invalid = serverInvalidFields(failure) as DetailField[];
      if (invalid.length > 0) {
        setErrors(Object.fromEntries(invalid.map((f) => [f, messages.errors.byCode.validation_failed])));
        queueMicrotask(() => focusFirstInvalid(formRef.current));
      }
      setFormError(describeFailure(failure));
    },
  });

  async function onHandleBlur() {
    const next = normaliseHandle(handle);
    if (next === (profile.handle ?? "") || handleError(next)) {
      setHandleNote(null);
      return;
    }
    setHandleNote(copy.handleChecking);
    try {
      const result = await checkHandle(next);
      if (result.available) {
        setHandleNote(copy.handleAvailable);
        setErrors((e) => ({ ...e, handle: undefined }));
      } else {
        setHandleNote(null);
        setErrors((e) => ({ ...e, handle: handleProblem(`handle_${result.reason}`) ?? copy.handleTaken }));
      }
    } catch {
      setHandleNote(null);
    }
  }

  function setDay(day: Weekday, change: Partial<DayState>) {
    setHoursTouched(true);
    setDays((current) => ({ ...current, [day]: { ...current[day], ...change } }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: FieldErrors<DetailField> = {};
    const nameProblem = nameError(displayName);
    if (nameProblem) next.displayName = nameProblem;
    const normalisedHandle = normaliseHandle(handle);
    const handleChanged = normalisedHandle !== (profile.handle ?? "");
    if (handleChanged) {
      const problem = handleError(normalisedHandle);
      if (problem) next.handle = problem;
    }
    const badDay = WEEKDAYS.find((day) => days[day].on && days[day].start >= days[day].end);
    if (badDay) next.workingHours = copy.endBeforeStart(dayName(badDay));
    setErrors(next);
    if (Object.values(next).some(Boolean)) {
      queueMicrotask(() => focusFirstInvalid(formRef.current));
      return;
    }
    const body: ProfileEdit = {
      displayName: displayName.trim(),
      pronouns,
      jobTitle,
      team,
      phone,
      location,
      timezone,
      region:
        country === "" ? null : subdivision.trim() === "" ? country : `${country}-${subdivision.trim().toUpperCase()}`,
    };
    if (handleChanged) body.handle = normalisedHandle;
    if (settingUp) body.onboarded = true;
    if (hoursTouched || !profile.workingHoursDefaulted) {
      body.workingHours = Object.fromEntries(
        WEEKDAYS.map((day) => [day, days[day].on ? [[days[day].start, days[day].end]] : []]),
      );
    }
    save.mutate(body);
  }

  return (
    <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-6">
      <Section title={copy.detailsTitle}>
        {formError ? <Alert>{formError}</Alert> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={copy.displayName}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            error={errors.displayName}
            required
            autoComplete="name"
          />
          <TextField
            label={copy.handle}
            hint={handleNote ?? copy.handleHint(profile.handleChangesLeft)}
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value);
              setHandleNote(null);
            }}
            onBlur={() => void onHandleBlur()}
            error={errors.handle}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <TextField
            label={copy.pronouns}
            hint={copy.pronounsHint}
            value={pronouns}
            onChange={(e) => setPronouns(e.target.value)}
          />
          <TextField
            label={copy.jobTitle}
            hint={copy.optional}
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            autoComplete="organization-title"
          />
          <TextField label={copy.team} hint={copy.optional} value={team} onChange={(e) => setTeam(e.target.value)} />
          <TextField
            label={copy.phone}
            hint={copy.optional}
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
          />
          <TextField
            label={copy.location}
            hint={copy.optional}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>
      </Section>

      <Section title={copy.timeTitle}>
        {deviceZone && deviceZone !== timezone && deviceZone !== profile.timezone ? (
          <Alert tone="info" className="flex flex-wrap items-center justify-between gap-2">
            <span>{copy.timezoneSuggest(deviceZone)}</span>
            <Button onClick={() => setTimezone(deviceZone)}>{copy.timezoneUse(deviceZone)}</Button>
          </Alert>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.tz} className="text-sm font-medium">
              {copy.timezone}
            </label>
            <p id={`${ids.tz}-hint`} className="text-sm text-muted">
              {copy.timezoneHint}
            </p>
            <select
              id={ids.tz}
              aria-describedby={`${ids.tz}-hint`}
              className={selectClass}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.country} className="text-sm font-medium">
              {copy.region}
            </label>
            <p id={`${ids.country}-hint`} className="text-sm text-muted">
              {copy.regionHint}
            </p>
            <select
              id={ids.country}
              aria-describedby={`${ids.country}-hint`}
              aria-invalid={errors.region ? true : undefined}
              className={selectClass}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            >
              <option value="">{copy.regionNone}</option>
              {countries.map(({ code, name }) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={copy.subdivision}
            hint={copy.subdivisionHint}
            value={subdivision}
            onChange={(e) => setSubdivision(e.target.value)}
            maxLength={3}
            autoComplete="off"
            disabled={country === ""}
          />
        </div>

        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={errors.workingHours ? `${ids.hoursHint} ${ids.hoursHint}-error` : ids.hoursHint}
        >
          <legend className="text-sm font-medium">{copy.workingHours}</legend>
          <p id={ids.hoursHint} className="text-sm text-muted">
            {copy.workingHoursHint}
            {profile.workingHoursDefaulted && !hoursTouched ? ` ${copy.workingHoursDefaulted}` : null}
          </p>
          {errors.workingHours ? (
            <p id={`${ids.hoursHint}-error`} className="text-sm text-danger">
              {errors.workingHours}
            </p>
          ) : null}
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {WEEKDAYS.map((day) => (
              <WorkingDay key={day} day={day} state={days[day]} onChange={(change) => setDay(day, change)} />
            ))}
          </ul>
        </fieldset>
        <div>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? copy.saving : copy.save}
          </Button>
        </div>
      </Section>
    </form>
  );
}

function WorkingDay({
  day,
  state,
  onChange,
}: {
  day: Weekday;
  state: DayState;
  onChange: (change: Partial<DayState>) => void;
}) {
  const checkboxId = useId();
  const name = dayName(day);
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      <span className="flex min-w-36 items-center gap-2">
        <input
          id={checkboxId}
          type="checkbox"
          className="size-4"
          checked={state.on}
          onChange={(e) => onChange({ on: e.target.checked })}
          aria-label={copy.worksOn(name)}
        />
        <label htmlFor={checkboxId}>{name}</label>
      </span>
      <input
        type="time"
        className={selectClass}
        value={state.start}
        disabled={!state.on}
        aria-label={copy.startsAt(name)}
        onChange={(e) => onChange({ start: e.target.value })}
      />
      <span aria-hidden="true">–</span>
      <input
        type="time"
        className={selectClass}
        value={state.end}
        disabled={!state.on}
        aria-label={copy.endsAt(name)}
        onChange={(e) => onChange({ end: e.target.value })}
      />
    </li>
  );
}
