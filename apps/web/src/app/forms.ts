import {
  emailSchema,
  HANDLE_PATTERN,
  MAX_DISPLAY_NAME_LENGTH,
  passwordProblem,
  RESERVED_HANDLES,
  type PasswordProblem,
} from "@officebox/shared";
import { ApiRequestError } from "../lib/api/client";
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

const PASSWORD_COPY: Record<PasswordProblem, string> = {
  too_short: copy.passwordTooShort,
  too_long: copy.passwordTooLong,
  common: copy.passwordCommon,
};

export function newPasswordError(value: string): string | null {
  if (value === "") return copy.required;
  const problem = passwordProblem(value);
  return problem ? PASSWORD_COPY[problem] : null;
}

/** Suggests a handle from a display name: "Sam Lee" → "sam.lee" (Identity §4.3 "suggested from their name"). */
export function suggestHandle(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32)
    .replace(/[._-]+$/g, "");
  return slug;
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
