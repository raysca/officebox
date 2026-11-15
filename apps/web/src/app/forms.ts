import { emailSchema, HANDLE_PATTERN, MAX_DISPLAY_NAME_LENGTH, RESERVED_HANDLES } from "@officebox/shared";
import { ApiRequestError, describeApiError } from "../lib/api/client";
import type { PasskeyFailure } from "../lib/api/identity";
import { messages } from "./messages";

/**
 * Field validation for the identity forms. The rules are the shared schemas' rules (packages/shared
 * identity.ts), checked here first so people see problems without a round trip; the copy comes from
 * `messages.ts`, never from Zod or the server.
 */

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

const copy = messages.form;

export function requiredError(value: string): string | null {
  return value.trim() === "" ? copy.required : null;
}

export function emailError(value: string): string | null {
  if (value.trim() === "") return copy.required;
  return emailSchema.safeParse(value).success ? null : copy.emailInvalid;
}

export function nameError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return copy.required;
  return [...trimmed].length > MAX_DISPLAY_NAME_LENGTH ? copy.nameTooLong : null;
}

export function handleError(value: string): string | null {
  const handle = value.trim().toLowerCase();
  if (handle === "") return copy.required;
  if (!HANDLE_PATTERN.test(handle)) return copy.handleInvalid;
  return RESERVED_HANDLES.has(handle) ? copy.handleReserved : null;
}

/** Suggests a handle from a display name: "Sam Lee" → "sam.lee" (Identity §4.3 "suggested from their name"). */
export function suggestHandle(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32)
    .replace(/[._-]+$/g, "");
}

/** The fields a `validation_failed` response flagged, in request order. */
export function serverInvalidFields(error: unknown): string[] {
  if (!(error instanceof ApiRequestError) || error.detail.kind !== "api") return [];
  if (error.detail.error.code !== "validation_failed") return [];
  return Object.keys(error.detail.error.fields ?? {}).map((path) => path.split(".")[0] ?? path);
}

/** Moves focus to the first field with an error, in DOM order. */
export function focusFirstInvalid(form: HTMLFormElement | null): void {
  form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}

/** What to tell someone when a passkey ceremony fails, in the browser or at the server. */
export function describePasskeyFailure(failure: PasskeyFailure): string {
  const p = messages.passkey;
  if (failure.kind === "ceremony") {
    if (failure.reason === "cancelled") return p.cancelled;
    if (failure.reason === "already_registered") return p.alreadyRegistered;
    return p.failed;
  }
  const { error } = failure;
  if (error.kind === "api") {
    const reason = error.error.reason;
    if (reason === "clone_detected") return p.cloneDetected;
    if (reason === "USER_VERIFICATION_REQUIRED") return p.uvRequired;
    if (reason === "PASSKEY_NOT_FOUND") return messages.signIn.unknownPasskey;
    if (error.error.code === "rate_limited" && error.retryAfterSeconds !== undefined) {
      return messages.signIn.tooMany(error.retryAfterSeconds);
    }
  }
  return describeApiError(error, "mutation");
}
