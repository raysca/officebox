import { z } from "zod";
import { ulidSchema } from "./ids";
import { FRESH_AUTH_METHODS, INVITABLE_WORKSPACE_ROLES, workspaceRoleSchema } from "./permissions";

/**
 * Identity & Access schemas for M1a (Identity §4.1, §4.4, §4.5, §4.6a, §6): first-run setup with a
 * passkey, the signed-in member, passkeys, "My devices", step-up and the security-notice banner.
 *
 * There are no passwords (Identity §2). Passkey ceremonies use better-auth's own routes, whose
 * WebAuthn JSON is SimpleWebAuthn's; only the envelopes around them are described here.
 */

// ---- Field rules -------------------------------------------------------------------------------

export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_WORKSPACE_NAME_LENGTH = 64;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSKEY_NAME_LENGTH = 64;

/**
 * Email normalisation for lookup, uniqueness and rate-limit keys (Identity §4.4, §5): trim, lowercase,
 * Unicode NFKC. NFKC runs first, so compatibility characters fold to letters that lower-casing then
 * handles ("ℌ" → "H" → "h"), and again after, because lower-casing can leave a decomposed sequence
 * ("İ" → "i" + U+0307).
 */
export function normaliseEmail(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase().normalize("NFKC");
}

/**
 * Identity §4.8: reserved words that can't be anyone's handle. The handle derived from the assistant's
 * display name is reserved too; it depends on a setting, so M1d's handle service checks it as well.
 */
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
  "assistant",
]);

/** Identity §4.8: 2–32 characters of `a-z 0-9 . _ -`, starting with a letter or digit. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** Counts characters as people see them (code points), not UTF-16 units. */
function length(value: string): number {
  return [...value].length;
}

/** An email as entered (trimmed); its normalised form is derived with `normaliseEmail`. */
export const emailSchema = z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email());

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

/** Whether a host is a `*.workers.dev` subdomain (Identity §4.1, §4.4: the domain warning). */
export function isWorkersDevHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  return h === "workers.dev" || h.endsWith(".workers.dev");
}

// ---- First-run setup (Identity §4.1, TDD §6.8) ------------------------------------------------

/** Where the setup token comes from: the `SETUP_TOKEN` secret, or one generated into Workers Logs. */
export const setupTokenSourceSchema = z.enum(["secret", "generated"]);
export type SetupTokenSource = z.infer<typeof setupTokenSourceSchema>;

/**
 * Where a sign-in key comes from (Platform §16, M1b-1): a Worker secret, or a key the Worker generated
 * and keeps in the SystemObject's storage. Admins see this, never a value.
 */
export const signInKeySourceSchema = z.enum(["worker_secret", "generated"]);
export type SignInKeySource = z.infer<typeof signInKeySourceSchema>;

/** The required services checked before setup can proceed (Identity §4.1, TDD §6.8; M1b-1). */
export const SETUP_SERVICE_IDS = [
  "d1",
  "durable_objects",
  "queues",
  "r2",
  "better_auth_secret",
  "token_hash_key",
] as const;
export const setupServiceIdSchema = z.enum(SETUP_SERVICE_IDS);
export type SetupServiceId = z.infer<typeof setupServiceIdSchema>;

/**
 * The fixed problem codes a failing service reports. Never a value, length, account or resource ID, or
 * raw error: those go to the Worker log only.
 */
export const SETUP_SERVICE_PROBLEMS = ["missing", "unreachable", "migrations_pending", "invalid_secret"] as const;
export const setupServiceProblemSchema = z.enum(SETUP_SERVICE_PROBLEMS);
export type SetupServiceProblem = z.infer<typeof setupServiceProblemSchema>;

export const setupServiceSchema = z.object({
  id: setupServiceIdSchema,
  ok: z.boolean(),
  /** Set only when `ok` is false. */
  problem: setupServiceProblemSchema.optional(),
});
export type SetupService = z.infer<typeof setupServiceSchema>;

/** Length of the open claim window: 60 minutes from `installation.setup_opened_at` (Identity §4.1). */
export const SETUP_OPEN_WINDOW_MS = 60 * 60 * 1000;

/**
 * How setup is protected right now: `open` (no token needed until `openUntil`) or `token` (the
 * `SETUP_TOKEN` secret, or the generated token in Workers Logs).
 */
export const setupModeSchema = z.enum(["open", "token"]);
export type SetupMode = z.infer<typeof setupModeSchema>;

/** `GET /api/setup` before setup completes. Afterwards the endpoint is 404. */
export const setupStatusSchema = z.object({
  setupRequired: z.literal(true),
  tokenSource: setupTokenSourceSchema,
  /** Setup was claimed and the owner hasn't registered a passkey yet: resume with the same token. */
  claimed: z.boolean(),
  /** Each required service, in a fixed order (M1b-1). Setup is blocked while any fails. */
  services: z.array(setupServiceSchema),
  /** `open` while the open claim window lasts (M1b-1), otherwise `token`. */
  mode: setupModeSchema,
  /** End of the open claim window (epoch ms); present only while `mode` is `open`. */
  openUntil: z.number().int().optional(),
  /**
   * The server's clock when it answered (epoch ms), so the page counts the time left against the
   * server, not a skewed browser clock (M1b-1). Optional so an older Worker's answer still parses.
   */
  now: z.number().int().optional(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/**
 * `POST /api/setup`. There is no password: the owner registers a passkey next. `token` may be left out
 * (or empty) only while the open claim window lasts (M1b-1); afterwards the claim answers
 * `setup_token_required`.
 */
export const setupBodySchema = z.strictObject({
  token: z.string().max(512).optional(),
  workspaceName: workspaceNameSchema,
  ownerName: displayNameSchema,
  ownerHandle: handleSchema,
  ownerEmail: emailSchema,
});
export type SetupBody = z.infer<typeof setupBodySchema>;

/** `POST /api/setup/resume`: the setup token, or the setup resume code an open-window claim returned. */
export const setupResumeBodySchema = z.strictObject({ token: z.string().min(1).max(512) });
export type SetupResumeBody = z.infer<typeof setupResumeBodySchema>;

/** The answer to a claim or a resume: an enrolment ticket cookie is set; register a passkey next. */
export const setupEnrolmentSchema = z.object({
  ownerEmail: z.string(),
  /** Seconds the enrolment ticket stays valid. */
  enrolmentExpiresInSeconds: z.number().int().positive(),
  /**
   * The setup resume code, returned once by an open-window claim (M1b-1): it resumes registration on
   * another device in place of a setup token. Absent for token-mode claims and resumes.
   */
  resumeCode: z.string().optional(),
});
export type SetupEnrolment = z.infer<typeof setupEnrolmentSchema>;

// ---- Passkey labels and security notices (Identity §4.4, §4.6a) -------------------------------

/** How a passkey was created (`passkeys.created_via`, Identity §5, TDD §8.1). */
export const PASSKEY_CREATED_VIA = [
  "setup",
  "invitation",
  "recovery_link",
  "owner_recovery",
  "magic_link",
  "signed_in",
  "domain_move",
] as const;
export const passkeyCreatedViaSchema = z.enum(PASSKEY_CREATED_VIA);
export type PasskeyCreatedVia = z.infer<typeof passkeyCreatedViaSchema>;

/** Kinds of `security_notice` (Identity §4.6a, Notifications §3). M1a raises the first two. */
export const SECURITY_NOTICE_KINDS = [
  "passkey_added",
  "passkey_clone_detected",
  "magic_link_new_device",
  "recovery_link_issued",
  "recovery_link_used",
  "email_changed",
  "owner_recovery_used",
  "domain_moved",
  "member_export",
] as const;
export const securityNoticeKindSchema = z.enum(SECURITY_NOTICE_KINDS);
export type SecurityNoticeKind = z.infer<typeof securityNoticeKindSchema>;

export const securityNoticeDetailsSchema = z.object({
  passkeyName: z.string().nullable().optional(),
  createdVia: passkeyCreatedViaSchema.optional(),
  /** On an owner's copy of someone else's notice (a clone detected): whose account. */
  subjectName: z.string().optional(),
  /** A new-device magic-link sign-in: the browser and system, and the approximate place (Identity §4.4). */
  deviceLabel: z.string().nullable().optional(),
  approxLocation: z.string().nullable().optional(),
  /** Who acted (M1c): the admin or owner who issued a recovery link, changed an email or moved the domain. */
  actorName: z.string().optional(),
  /** An email change (M1c; Identity §4.11): the new address. */
  newEmail: z.string().optional(),
  /** A domain move (M1c; Identity §4.4): the new canonical origin. */
  origin: z.string().optional(),
});
export type SecurityNoticeDetails = z.infer<typeof securityNoticeDetailsSchema>;

export const securityNoticeSchema = z.object({
  id: ulidSchema,
  kind: securityNoticeKindSchema,
  at: z.number().int(),
  /** Kind-specific facts for the banner copy. Never secrets or tokens. */
  details: securityNoticeDetailsSchema,
});
export type SecurityNotice = z.infer<typeof securityNoticeSchema>;

export const securityNoticeListSchema = z.object({ notices: z.array(securityNoticeSchema) });
export type SecurityNoticeList = z.infer<typeof securityNoticeListSchema>;

/** `POST /api/me/security-notices/ack`: acknowledge the listed notices, or all of them when omitted. */
export const ackSecurityNoticesBodySchema = z.strictObject({ ids: z.array(ulidSchema).max(100).optional() });
export type AckSecurityNoticesBody = z.infer<typeof ackSecurityNoticesBodySchema>;

export const ackSecurityNoticesResultSchema = z.object({ acknowledged: z.number().int().nonnegative() });
export type AckSecurityNoticesResult = z.infer<typeof ackSecurityNoticesResultSchema>;

// ---- The signed-in member (Identity §6 `GET /me`) ---------------------------------------------

export const currentUserSchema = z.object({
  id: ulidSchema,
  email: z.string(),
  displayName: z.string(),
  handle: z.string().nullable(),
  role: workspaceRoleSchema,
  /** M1d: the avatar's same-origin URL, or null for initials. Optional so older answers still parse. */
  avatarUrl: z.string().nullable().optional(),
  /** M1d: the member's IANA time zone. */
  timezone: z.string().optional(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const meSchema = z.object({
  user: currentUserSchema,
  workspace: z.object({
    name: z.string(),
    /** The canonical origin (Identity §4.4); the web app warns when its host is `*.workers.dev`. */
    canonicalOrigin: z.string(),
  }),
  /** Registered passkeys: an owner with one sees the second-passkey reminder (Identity §4.4). */
  passkeyCount: z.number().int().nonnegative(),
  /** The banner list (Identity §4.6a). */
  securityNotices: z.array(securityNoticeSchema),
  /** This session's step-up facts (Identity §4.5). */
  session: z.object({
    freshAuthAt: z.number().int().nullable(),
    freshAuthMethod: z.enum(FRESH_AUTH_METHODS).nullable(),
  }),
  /**
   * Owners only (M1c; Identity §4.6): `RECOVERY_TOKEN` is still set although its value was used. Owners
   * see a banner until the secret is deleted. Optional so an older Worker's answer still parses.
   */
  ownerRecoveryUsed: z.boolean().optional(),
});
export type Me = z.infer<typeof meSchema>;

// ---- Passkeys (Identity §4.4) -----------------------------------------------------------------

export const passkeySummarySchema = z.object({
  id: ulidSchema,
  name: z.string().nullable(),
  createdVia: passkeyCreatedViaSchema,
  createdAt: z.number().int().nullable(),
  lastUsedAt: z.number().int().nullable(),
  /** "singleDevice" or "multiDevice" (synced), as the authenticator reported it. */
  deviceType: z.string(),
  backedUp: z.boolean(),
});
export type PasskeySummary = z.infer<typeof passkeySummarySchema>;

export const passkeyListSchema = z.object({ passkeys: z.array(passkeySummarySchema) });
export type PasskeyList = z.infer<typeof passkeyListSchema>;

export const passkeyNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => length(v) <= MAX_PASSKEY_NAME_LENGTH, {
    message: `At most ${MAX_PASSKEY_NAME_LENGTH} characters.`,
  });

/** `PATCH /api/me/passkeys/:id`. */
export const renamePasskeyBodySchema = z.strictObject({ name: passkeyNameSchema });
export type RenamePasskeyBody = z.infer<typeof renamePasskeyBodySchema>;

// ---- My devices (Identity §4.5) ---------------------------------------------------------------

export const deviceSessionSchema = z.object({
  id: ulidSchema,
  /** For example "Chrome on macOS"; null when the browser isn't recognised. */
  deviceLabel: z.string().nullable(),
  /** City and country from Cloudflare, when available. */
  approxLocation: z.string().nullable(),
  createdAt: z.number().int(),
  /** Last refresh of the sliding expiry: accurate to within a day (Identity §4.5). */
  lastSeenAt: z.number().int(),
  /** The session making this request. */
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

export const deviceSessionListSchema = z.object({ sessions: z.array(deviceSessionSchema) });
export type DeviceSessionList = z.infer<typeof deviceSessionListSchema>;

export const signedOutCountSchema = z.object({ signedOut: z.number().int().nonnegative() });
export type SignedOutCount = z.infer<typeof signedOutCountSchema>;

// ---- Step-up (Identity §4.5) ------------------------------------------------------------------

/**
 * A browser's WebAuthn response as SimpleWebAuthn JSON. Its contents are checked by the WebAuthn
 * verifier; here only that it is an object with a credential `id`.
 */
export const webAuthnResponseSchema = z.looseObject({ id: z.string().min(1).max(1024), type: z.string() });

/** `POST /api/me/reauth`. */
export const reauthBodySchema = z.strictObject({ response: webAuthnResponseSchema });
export type ReauthBody = z.infer<typeof reauthBodySchema>;

export const reauthResultSchema = z.object({ freshAuthAt: z.number().int() });
export type ReauthResult = z.infer<typeof reauthResultSchema>;

// ---- Invitations (Identity §4.2, §4.3, §6) ----------------------------------------------------

/** Invitations are single-use and expire after 7 days (Identity §2, Platform §10). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const invitableRoleSchema = z.enum(INVITABLE_WORKSPACE_ROLES);
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

/**
 * `POST /api/admin/invitations`. The link is always returned for copying; `sendEmail` also emails it
 * when email is configured (Identity §4.2). The email is bound to the link and can't be changed.
 */
export const createInvitationBodySchema = z.strictObject({
  email: emailSchema,
  role: invitableRoleSchema,
  sendEmail: z.boolean(),
});
export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;

/**
 * What happened to the email part of an invitation (the copy link always works). `limited`: the
 * workspace reached today's invitation-email limit (Platform §8, 200 per UTC day); copy the link. `email_unavailable`: the email couldn't be queued right now; the link still works.
 */
export const invitationEmailOutcomeSchema = z.enum([
  "queued",
  "not_requested",
  "not_configured",
  "limited",
  "email_unavailable",
]);
export type InvitationEmailOutcome = z.infer<typeof invitationEmailOutcomeSchema>;

/** `expired` is shown until it's revoked; `accepting` means accepted but the account isn't finished. */
export const invitationStatusSchema = z.enum(["pending", "expired", "accepting"]);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationSummarySchema = z.object({
  id: ulidSchema,
  email: z.string(),
  role: invitableRoleSchema,
  invitedBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  lastSentAt: z.number().int().nullable(),
  status: invitationStatusSchema,
  /**
   * M1c: the workspace moved to a new address after this link was made, so the old link no longer
   * works (Identity §4.4). "Copy again" or "Resend" makes a new one. Optional for older Workers.
   */
  needsNewLink: z.boolean().optional(),
});
export type InvitationSummary = z.infer<typeof invitationSummarySchema>;

export const invitationListSchema = z.object({ invitations: z.array(invitationSummarySchema) });
export type InvitationList = z.infer<typeof invitationListSchema>;

/** The copy link, built from the canonical origin with the token in the fragment (Identity §2). */
export const invitationLinkSchema = z.object({ link: z.string() });
export type InvitationLink = z.infer<typeof invitationLinkSchema>;

export const createInvitationResultSchema = z.object({
  invitation: invitationSummarySchema,
  link: z.string(),
  email: invitationEmailOutcomeSchema,
});
export type CreateInvitationResult = z.infer<typeof createInvitationResultSchema>;

export const resendInvitationResultSchema = z.object({ email: invitationEmailOutcomeSchema });
export type ResendInvitationResult = z.infer<typeof resendInvitationResultSchema>;

/** A link token as it travels in a JSON body: base64url of 32 random bytes (43 characters). */
export const linkTokenSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/** `POST /api/invitations/lookup`. */
export const invitationLookupBodySchema = z.strictObject({ token: linkTokenSchema });
export type InvitationLookupBody = z.infer<typeof invitationLookupBodySchema>;

export const invitationLookupSchema = z.object({
  /** Shown prominently, so nobody accepts an invitation meant for someone else (Identity §4.3). */
  email: z.string(),
  role: invitableRoleSchema,
  workspaceName: z.string(),
  /** `resume`: the account exists without a passkey; accepting again only registers the passkey. */
  state: z.enum(["new", "resume"]),
});
export type InvitationLookup = z.infer<typeof invitationLookupSchema>;

/**
 * `POST /api/invitations/accept`. Name and handle are required to create the account; when the
 * invitation is being resumed (the account exists without a passkey) they're ignored and may be left out.
 */
export const acceptInvitationBodySchema = z.strictObject({
  token: linkTokenSchema,
  name: displayNameSchema.optional(),
  handle: handleSchema.optional(),
});
export type AcceptInvitationBody = z.infer<typeof acceptInvitationBodySchema>;

/** The answer to an accept: an enrolment ticket cookie is set; register a passkey next. */
export const acceptInvitationResultSchema = z.object({
  email: z.string(),
  enrolmentExpiresInSeconds: z.number().int().positive(),
  resumed: z.boolean(),
});
export type AcceptInvitationResult = z.infer<typeof acceptInvitationResultSchema>;

// ---- Magic links (Identity §4.4) --------------------------------------------------------------

/** Magic links are single-use and valid for 15 minutes (`expiresIn: 900`). */
export const MAGIC_LINK_TTL_SECONDS = 900;

/**
 * `POST /api/auth/sign-in/magic-link` (better-auth's request route behind our middleware). Only the
 * email is accepted: callback URLs are refused, because the emailed link is always our own page.
 */
export const magicLinkRequestBodySchema = z.strictObject({ email: emailSchema });
export type MagicLinkRequestBody = z.infer<typeof magicLinkRequestBodySchema>;

/** `POST /api/sign-in/link`: the confirmation page's POST. */
export const magicLinkConfirmBodySchema = z.strictObject({ token: linkTokenSchema });
export type MagicLinkConfirmBody = z.infer<typeof magicLinkConfirmBodySchema>;

export const magicLinkConfirmResultSchema = z.object({ signedIn: z.literal(true) });

/**
 * `POST /api/sign-in/link/lookup`: what the confirmation page shows before Continue ("Sign in to
 * *Workspace* as **email**", Platform §10), so a link someone else shared is obvious. Uses nothing.
 */
export const magicLinkLookupSchema = z.object({ email: z.string(), workspaceName: z.string() });
export type MagicLinkLookup = z.infer<typeof magicLinkLookupSchema>;
export type MagicLinkConfirmResult = z.infer<typeof magicLinkConfirmResultSchema>;

// ---- Allowed invite domains (Identity §4.2, Platform §7) --------------------------------------

/** A bare domain such as `example.com`, lower-cased. */
export const inviteDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/, {
    message: "A domain such as example.com.",
  });

/** `allowed_invite_domains`: empty means any domain (the default, off). */
export const allowedInviteDomainsSchema = z.array(inviteDomainSchema).max(50);

/** Whether an email's domain is allowed by the setting (an empty list allows every domain). */
export function isInviteDomainAllowed(email: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = normaliseEmail(email.slice(at + 1));
  return allowed.includes(domain);
}

// ---- Recovery links and owner recovery (Identity §4.6, M1c) -----------------------------------

/** Recovery links are single-use and valid for 24 hours (Identity §4.6, Platform §10). */
export const RECOVERY_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** The minimum length of `RECOVERY_TOKEN`, in characters (Identity §4.6, Platform §16). */
export const RECOVERY_TOKEN_MIN_LENGTH = 32;

/** `POST /api/admin/members/:id/recovery-link`: the copy link (token in the fragment) and when it expires. */
export const recoveryLinkResultSchema = z.object({
  link: z.string(),
  expiresAt: z.number().int(),
  /** The person is told by email too (email configured), besides the banner list. */
  notifiedByEmail: z.boolean(),
  /** Email isn't configured: the member is flagged to every owner and warned on the sign-in page. */
  flagged: z.boolean(),
});
export type RecoveryLinkResult = z.infer<typeof recoveryLinkResultSchema>;

/** `POST /api/auth/recover/lookup` and `POST /api/auth/recover`: the link's token. */
export const recoveryLinkBodySchema = z.strictObject({ token: linkTokenSchema });
export type RecoveryLinkBody = z.infer<typeof recoveryLinkBodySchema>;

/** What the recovery page shows before Continue: the account's email, prominently. */
export const recoveryLookupSchema = z.object({ email: z.string(), workspaceName: z.string() });
export type RecoveryLookup = z.infer<typeof recoveryLookupSchema>;

/** The answer to using a recovery link or owner recovery: an enrolment ticket cookie is set. */
export const recoveryEnrolmentSchema = z.object({
  email: z.string(),
  enrolmentExpiresInSeconds: z.number().int().positive(),
});
export type RecoveryEnrolment = z.infer<typeof recoveryEnrolmentSchema>;

/** `POST /api/recover`: owner recovery with the `RECOVERY_TOKEN` secret, for one owner named by email. */
export const ownerRecoveryBodySchema = z.strictObject({
  token: z.string().min(1).max(1024),
  email: emailSchema,
});
export type OwnerRecoveryBody = z.infer<typeof ownerRecoveryBodySchema>;

// ---- Email change (Identity §4.11, M1c) -------------------------------------------------------

/** Email-change confirmation links are single-use and valid for 24 hours (Platform §10). */
export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `PATCH /api/admin/members/:id`. M1c handles `email`; role and status changes arrive with M1e, which
 * extends this schema.
 */
export const patchMemberBodySchema = z.strictObject({ email: emailSchema });
export type PatchMemberBody = z.infer<typeof patchMemberBodySchema>;

/**
 * The outcome of an email change: `pending_confirmation` when email is configured (a confirmation link
 * went to the new address), `changed` when it isn't (it takes effect at once).
 */
export const emailChangeResultSchema = z.object({
  status: z.enum(["pending_confirmation", "changed"]),
  email: z.string(),
});
export type EmailChangeResult = z.infer<typeof emailChangeResultSchema>;

/** `POST /api/me/email/confirm/lookup` and `POST /api/me/email/confirm`. */
export const emailChangeConfirmBodySchema = z.strictObject({ token: linkTokenSchema });
export type EmailChangeConfirmBody = z.infer<typeof emailChangeConfirmBodySchema>;

export const emailChangeLookupSchema = z.object({ newEmail: z.string(), workspaceName: z.string() });
export type EmailChangeLookup = z.infer<typeof emailChangeLookupSchema>;

export const emailChangeConfirmResultSchema = z.object({ email: z.string() });
export type EmailChangeConfirmResult = z.infer<typeof emailChangeConfirmResultSchema>;

// ---- Members for the admin area (Identity §4.6, §4.11; Admin §5; M1c's subset) ----------------

export const adminMemberSchema = z.object({
  id: ulidSchema,
  email: z.string(),
  displayName: z.string(),
  handle: z.string().nullable(),
  role: workspaceRoleSchema,
  status: z.enum(["active", "disabled"]),
  passkeyCount: z.number().int().nonnegative(),
  /**
   * Owners only: a recovery link was issued without email and no owner has acknowledged it yet
   * (Identity §4.6). Always null for admins.
   */
  recoveryFlag: z.object({ at: z.number().int(), byName: z.string().nullable() }).nullable(),
  /** An email change waiting for its confirmation link to be used. */
  pendingEmail: z.string().nullable(),
});
export type AdminMember = z.infer<typeof adminMemberSchema>;

export const adminMemberListSchema = z.object({ members: z.array(adminMemberSchema) });
export type AdminMemberList = z.infer<typeof adminMemberListSchema>;

// ---- Domain move (Identity §4.4, M1c) ---------------------------------------------------------

/** A pending domain move expires 24 hours after it starts (Identity §2, default). */
export const DOMAIN_MOVE_TTL_MS = 24 * 60 * 60 * 1000;

/** Whether a host name is a loopback name (`localhost`, `*.localhost`), where `http:` is allowed (local runs). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

const ORIGIN_MESSAGE = "An address such as https://work.example.com, with nothing after it.";

/**
 * A new address for the workspace: an origin only (no path, query, fragment or credentials), `https:`
 * (or `http:` on a loopback name, for local runs), with a domain name rather than an IP address, since a
 * passkey's relying-party ID must be a domain **(default)**. Normalised to `URL.origin`.
 */
export const domainOriginSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: ORIGIN_MESSAGE });
      return z.NEVER;
    }
    const loopback = isLoopbackHost(url.hostname);
    const bare = url.pathname === "/" && url.search === "" && url.hash === "" && !/[?#]/.test(value);
    const noCredentials = url.username === "" && url.password === "";
    const secure = url.protocol === "https:" || (url.protocol === "http:" && loopback);
    const ip = /^[0-9.]+$/.test(url.hostname) || url.hostname.startsWith("[");
    const domain = loopback || url.hostname.includes(".");
    if (!bare || !noCredentials || !secure || ip || !domain) {
      ctx.addIssue({ code: "custom", message: ORIGIN_MESSAGE });
      return z.NEVER;
    }
    return url.origin;
  });

/** `POST /api/admin/domain`. */
export const startDomainMoveBodySchema = z.strictObject({ origin: domainOriginSchema });
export type StartDomainMoveBody = z.infer<typeof startDomainMoveBodySchema>;

/** The move link for the new origin, shown once to the owner who started the move. */
export const startDomainMoveResultSchema = z.object({
  origin: z.string(),
  link: z.string(),
  expiresAt: z.number().int(),
});
export type StartDomainMoveResult = z.infer<typeof startDomainMoveResultSchema>;

/** `GET /api/admin/domain` (owners): the current address and any pending move. */
export const domainStatusSchema = z.object({
  canonicalOrigin: z.string(),
  pending: z
    .object({
      origin: z.string(),
      expiresAt: z.number().int(),
      startedBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
    })
    .nullable(),
});
export type DomainStatus = z.infer<typeof domainStatusSchema>;

/** `POST /api/admin/domain/complete`, on the new origin: the move link's token. */
export const completeDomainMoveBodySchema = z.strictObject({ token: linkTokenSchema });
export type CompleteDomainMoveBody = z.infer<typeof completeDomainMoveBodySchema>;

/** The answer on the new origin: an enrolment ticket cookie is set; registering a passkey commits the move. */
export const completeDomainMoveResultSchema = z.object({
  email: z.string(),
  origin: z.string(),
  workspaceName: z.string(),
  enrolmentExpiresInSeconds: z.number().int().positive(),
});
export type CompleteDomainMoveResult = z.infer<typeof completeDomainMoveResultSchema>;
