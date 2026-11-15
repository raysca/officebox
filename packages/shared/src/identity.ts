import { z } from "zod";
import { COMMON_PASSWORDS } from "./common-passwords";
import { ulidSchema } from "./ids";
import { workspaceRoleSchema } from "./permissions";

/**
 * Identity & Access schemas (Identity §4.1, §4.4, §4.5, §6): setup, password sign-in, the signed-in
 * member and "My devices".
 */

// ---- Field rules -------------------------------------------------------------------------------

/** Identity §4.4: at least 10 characters, no composition rules. Raised (never lowered) by the `min_password_length` setting. */
export const MIN_PASSWORD_LENGTH = 10;
/** Upper bound on a password, so a request can't make the Worker HMAC megabytes of text (default). */
export const MAX_PASSWORD_LENGTH = 256;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_WORKSPACE_NAME_LENGTH = 64;
export const MAX_EMAIL_LENGTH = 254;

/** Identity §4.8: reserved words that can't be anyone's handle. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "channel",
  "here",
  "everyone",
  "all",
  "admin",
  "admins",
  "owner",
  "system",
  "officebox",
]);

/** Identity §4.8: 2–32 characters of `a-z 0-9 . _ -`, starting with a letter or digit. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** Counts characters as people see them (code points), not UTF-16 units. */
function length(value: string): number {
  return [...value].length;
}

export type PasswordProblem = "too_short" | "too_long" | "common";

/** Why a new password is refused, or null when it is acceptable. */
export function passwordProblem(password: string, minLength = MIN_PASSWORD_LENGTH): PasswordProblem | null {
  const chars = length(password);
  if (chars < minLength) return "too_short";
  if (chars > MAX_PASSWORD_LENGTH) return "too_long";
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return "common";
  return null;
}

const PASSWORD_MESSAGES: Record<PasswordProblem, string> = {
  too_short: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  too_long: `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
  common: "This password is too common.",
};

/**
 * A password being set (setup now; reset and change in later slices). Never trimmed, but NFC-normalised
 * (here and at sign-in), so the same characters typed on different keyboards hash the same.
 */
export const newPasswordSchema = z
  .string()
  .normalize("NFC")
  .superRefine((value, ctx) => {
    const problem = passwordProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: PASSWORD_MESSAGES[problem], params: { problem } });
  });

/** Email addresses are stored and compared trimmed, NFC-normalised and lower-cased **(default)**. */
// Lower-case first, then normalise: lower-casing can produce decomposed sequences (İ → i + U+0307).
export const emailSchema = z.string().trim().toLowerCase().normalize("NFC").max(MAX_EMAIL_LENGTH).pipe(z.email());

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => length(v) <= MAX_DISPLAY_NAME_LENGTH, { message: `At most ${MAX_DISPLAY_NAME_LENGTH} characters.` });

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => length(v) <= MAX_WORKSPACE_NAME_LENGTH, {
    message: `At most ${MAX_WORKSPACE_NAME_LENGTH} characters.`,
  });

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HANDLE_PATTERN, { message: "2–32 lowercase letters, digits, dots, dashes or underscores." })
  .refine((v) => !RESERVED_HANDLES.has(v), { message: "This handle is reserved." });

// ---- First-run setup (Identity §4.1, TDD §6.8) ------------------------------------------------

/** Where the setup token comes from: the `SETUP_TOKEN` secret, or one generated into Workers Logs. */
export const setupTokenSourceSchema = z.enum(["secret", "generated"]);
export type SetupTokenSource = z.infer<typeof setupTokenSourceSchema>;

/** `GET /api/setup` before setup. After setup the endpoint is 404. */
export const setupStatusSchema = z.object({
  setupRequired: z.literal(true),
  tokenSource: setupTokenSourceSchema,
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** `POST /api/setup`. */
export const setupBodySchema = z.strictObject({
  token: z.string().min(1).max(512),
  workspaceName: workspaceNameSchema,
  ownerName: displayNameSchema,
  ownerHandle: handleSchema,
  ownerEmail: emailSchema,
  password: newPasswordSchema,
});
export type SetupBody = z.infer<typeof setupBodySchema>;

export const setupResultSchema = z.object({ ownerEmail: z.string() });
export type SetupResult = z.infer<typeof setupResultSchema>;

// ---- Sign-in (Identity §4.4) ------------------------------------------------------------------

/**
 * `POST /api/auth/password`. The password isn't checked against the policy here: an old password
 * that predates a raised minimum must still sign in.
 */
export const passwordSignInBodySchema = z.strictObject({
  email: emailSchema,
  password: z.string().normalize("NFC").min(1).max(MAX_PASSWORD_LENGTH),
});
export type PasswordSignInBody = z.infer<typeof passwordSignInBodySchema>;

// ---- The signed-in member (Identity §6 `GET /me`) ---------------------------------------------

export const currentUserSchema = z.object({
  id: ulidSchema,
  email: z.string(),
  displayName: z.string(),
  handle: z.string().nullable(),
  role: workspaceRoleSchema,
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const meSchema = z.object({
  user: currentUserSchema,
  workspace: z.object({ name: z.string() }),
});
export type Me = z.infer<typeof meSchema>;

// ---- My devices (Identity §4.5) ---------------------------------------------------------------

export const deviceSessionSchema = z.object({
  id: ulidSchema,
  /** For example "Chrome on macOS"; null when the browser isn't recognised. */
  deviceLabel: z.string().nullable(),
  /** City and country from Cloudflare, when available. */
  approxLocation: z.string().nullable(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
  /** The session making this request. */
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

export const deviceSessionListSchema = z.object({ sessions: z.array(deviceSessionSchema) });
export type DeviceSessionList = z.infer<typeof deviceSessionListSchema>;

export const signOutOthersResultSchema = z.object({ signedOut: z.number().int().nonnegative() });
export type SignOutOthersResult = z.infer<typeof signOutOthersResultSchema>;
