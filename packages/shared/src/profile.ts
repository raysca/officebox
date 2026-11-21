import { z } from "zod";
import { ulidSchema } from "./ids";
import { displayNameSchema, HANDLE_PATTERN, RESERVED_HANDLES } from "./identity";

/**
 * Profiles, @handles and the member directory (M1d; Identity §4.7, §4.8, §4.10, §6; Permissions §4.6;
 * Platform §3.1, §8).
 *
 * Everything here is pure and environment-neutral (Zod and `Intl` only), so the Worker validates with
 * exactly the rules the web app shows. Timestamps are UTC epoch milliseconds; times of day are `HH:MM`
 * in the member's IANA time zone (AGENTS §4.1).
 */

// ---- Field limits (Identity §4.7; lengths not given by the spec are defaults) -----------------

export const MAX_JOB_TITLE_LENGTH = 100; // (default)
export const MAX_TEAM_LENGTH = 100; // (default)
export const MAX_PRONOUNS_LENGTH = 40; // (default)
export const MAX_PHONE_LENGTH = 40; // (default)
export const MAX_LOCATION_LENGTH = 100; // (default)
export const MAX_STATUS_TEXT_LENGTH = 100; // (default)
export const MAX_TIMEZONE_LENGTH = 64;
/** A status can be set to clear itself at most this far ahead **(default)**. */
export const MAX_STATUS_DURATION_MS = 366 * 24 * 60 * 60 * 1000;

/** A released handle is held this long before someone else can claim it (Identity §4.8). */
export const HANDLE_HOLD_MS = 30 * 24 * 60 * 60 * 1000;
/** Handle changes per user per 30 days (Platform §8, default). */
export const HANDLE_CHANGES_PER_WINDOW = 3;
export const HANDLE_CHANGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Code points, as people count characters. */
function length(value: string): number {
  return [...value].length;
}

/** An optional free-text field: trimmed; empty means "not set" (null). */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .refine((v) => length(v) <= max, { message: `At most ${max} characters.` })
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .transform((v) => v ?? null);
}

// ---- Time zones (Identity §4.7: IANA name, validated server-side) ------------------------------

const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * Whether `value` is an IANA time zone name the runtime knows (`Europe/Berlin`, `UTC`). Offsets such
 * as `+05:00` aren't zone names and are refused, even where `Intl` would accept them.
 */
export function isValidTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > MAX_TIMEZONE_LENGTH || !TIMEZONE_PATTERN.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The runtime's canonical spelling of a valid zone (`europe/berlin` → `Europe/Berlin`, `utc` → `UTC`), so
 * one zone is stored one way. Aliases keep whatever name the runtime's ICU data resolves them to.
 */
export function canonicalTimeZone(value: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
}

/** An IANA zone name, validated and then canonicalised (the Worker stores the canonical form). */
export const timeZoneSchema = z
  .string()
  .trim()
  .refine(isValidTimeZone, { message: "Choose a time zone from the list (an IANA name such as Europe/Berlin)." })
  .transform(canonicalTimeZone);

// ---- Working hours (Identity §4.7: per weekday, start and end, in the member's time zone) ------

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** `HH:MM`, 00:00–23:59; an interval may end at `24:00` (midnight at the end of the day). */
const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Must be HH:MM (00:00–23:59).");
const endOfDaySchema = z.union([timeOfDaySchema, z.literal("24:00")]);

export const workingIntervalSchema = z
  .tuple([timeOfDaySchema, endOfDaySchema])
  .refine(([start, end]) => start < end, { message: "The end must be after the start." });
export type WorkingInterval = z.infer<typeof workingIntervalSchema>;

/** One day: up to 4 intervals, in order and not overlapping; empty means not working that day. */
const workingDaySchema = z
  .array(workingIntervalSchema)
  .max(4)
  .refine((day) => day.every((interval, i) => i === 0 || day[i - 1]![1] <= interval[0]), {
    message: "Intervals must be in order and must not overlap.",
  });

/** Stored as JSON in `users.working_hours` (Identity §5): `{ mon: [["09:00","17:00"]], … }`. */
export const workingHoursSchema = z.object({
  mon: workingDaySchema,
  tue: workingDaySchema,
  wed: workingDaySchema,
  thu: workingDaySchema,
  fri: workingDaySchema,
  sat: workingDaySchema,
  sun: workingDaySchema,
});
export type WorkingHours = z.infer<typeof workingHoursSchema>;

/** Input: any weekday may be left out, which means not working that day. Normalised to all seven. */
export const workingHoursInputSchema = z
  .strictObject({
    mon: workingDaySchema.optional(),
    tue: workingDaySchema.optional(),
    wed: workingDaySchema.optional(),
    thu: workingDaySchema.optional(),
    fri: workingDaySchema.optional(),
    sat: workingDaySchema.optional(),
    sun: workingDaySchema.optional(),
  })
  .transform((input): WorkingHours => ({
    mon: input.mon ?? [],
    tue: input.tue ?? [],
    wed: input.wed ?? [],
    thu: input.thu ?? [],
    fri: input.fri ?? [],
    sat: input.sat ?? [],
    sun: input.sun ?? [],
  }));

/** Mon–Fri 09:00–17:00 local (Identity §4.3): used until the member sets their own. */
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [],
  sun: [],
};

/** The stored working hours, or the default when none are stored or the stored JSON is unreadable. */
export function parseWorkingHours(raw: string | null): { hours: WorkingHours; defaulted: boolean } {
  if (raw) {
    try {
      const parsed = workingHoursSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return { hours: parsed.data, defaulted: false };
    } catch {
      // fall through to the default
    }
  }
  return { hours: DEFAULT_WORKING_HOURS, defaulted: true };
}

// ---- Region (Identity §4.7: country and optional subdivision, ISO 3166-1/-2) -------------------

/** ISO 3166-1 alpha-2 country codes. */
export const COUNTRY_CODES: ReadonlySet<string> = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV " +
    "BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES " +
    "ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE " +
    "IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
    "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU " +
    "NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM " +
    "SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE " +
    "VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

const REGION_PATTERN = /^([A-Z]{2})(?:-[A-Z0-9]{1,3})?$/;

/**
 * `GB`, `GB-ENG`, `US-CA`. The country must be a real ISO 3166-1 code; the subdivision's shape is
 * checked, not its existence (no ISO 3166-2 table is shipped) **(default)**.
 */
export function isValidRegion(value: string): boolean {
  const match = REGION_PATTERN.exec(value);
  return match !== null && COUNTRY_CODES.has(match[1]!);
}

export const regionSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidRegion, { message: "A country code, optionally with a subdivision (for example GB-ENG)." });

// ---- Status (Identity §4.7: emoji, text and an optional expiry) --------------------------------

const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]️?⃣/u;

/** Exactly one emoji (one grapheme cluster that is an emoji, flags and ZWJ sequences included). */
export function isSingleEmoji(value: string): boolean {
  if (value.length === 0 || value.length > 32 || !EMOJI_PATTERN.test(value)) return false;
  // Letters, digits or spaces mixed in aren't an emoji (keycaps such as 1️⃣ are matched above).
  if (/[\p{L}\s]/u.test(value)) return false;
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return segments.length === 1;
}

export const statusEmojiSchema = z.string().trim().refine(isSingleEmoji, { message: "Choose a single emoji." });

/** `PUT /api/me/status`. Both emoji and text empty clears the status. */
export const setStatusBodySchema = z.strictObject({
  emoji: z
    .union([statusEmojiSchema, z.literal("")])
    .nullable()
    .transform((v) => (v === "" ? null : v)),
  text: optionalText(MAX_STATUS_TEXT_LENGTH),
  /** When the status clears itself (epoch ms), or null to keep it until cleared. */
  expiresAt: z.number().int().positive().nullable(),
});
export type SetStatusBody = z.infer<typeof setStatusBodySchema>;

export const memberStatusSchema = z.object({
  emoji: z.string().nullable(),
  text: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
});
export type MemberStatus = z.infer<typeof memberStatusSchema>;

/** The status as others see it at `now`: null once it has expired, or when nothing is set. */
export function effectiveStatus(
  stored: { emoji: string | null; text: string | null; expiresAt: number | null },
  now: number,
): MemberStatus | null {
  if (stored.emoji === null && stored.text === null) return null;
  if (stored.expiresAt !== null && stored.expiresAt <= now) return null;
  return { emoji: stored.emoji, text: stored.text, expiresAt: stored.expiresAt };
}

/** One line for presence lists: "🌴 On holiday", or null. */
export function statusLine(status: MemberStatus | null): string | null {
  if (!status) return null;
  return [status.emoji, status.text].filter((part): part is string => part !== null).join(" ") || null;
}

// ---- @handles (Identity §4.8) --------------------------------------------------------------------

/** Lower-cases and trims what someone typed, the way handles are stored. */
export function normaliseHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

/** Why a handle can't be used, from its shape alone (the database answers the rest). */
export function handleShapeProblem(handle: string): "invalid" | "reserved" | null {
  if (!HANDLE_PATTERN.test(handle)) return "invalid";
  if (RESERVED_HANDLES.has(handle)) return "reserved";
  return null;
}

/**
 * The handle derived from the assistant's display name (Identity §4.8, Assistant §2): lower-cased,
 * letters and digits kept, anything else dropped (`Butler` → `butler`). Reserved as a `handles` row with
 * `owner_type = 'reserved'`; null when nothing usable is left.
 */
export function assistantDerivedHandle(displayName: string): string | null {
  const derived = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
  return HANDLE_PATTERN.test(derived) ? derived : null;
}

/** The assistant's default display name (`assistant_display_name`, Assistant §10.1). */
export const DEFAULT_ASSISTANT_DISPLAY_NAME = "Butler";

export const HANDLE_UNAVAILABLE_REASONS = ["invalid", "reserved", "taken", "held"] as const;
export const handleUnavailableReasonSchema = z.enum(HANDLE_UNAVAILABLE_REASONS);
export type HandleUnavailableReason = z.infer<typeof handleUnavailableReasonSchema>;

/** `GET /api/handles/:handle/available`. `held`: released by someone within the last 30 days. */
export const handleAvailabilitySchema = z.object({
  handle: z.string(),
  available: z.boolean(),
  /** True when it's already the asker's own handle. */
  yours: z.boolean(),
  reason: handleUnavailableReasonSchema.optional(),
});
export type HandleAvailability = z.infer<typeof handleAvailabilitySchema>;

// ---- Avatars (Identity §4.7, TDD §8.3) ----------------------------------------------------------

/** PNG, JPEG or WebP only (Identity §4.7). */
export const AVATAR_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];
/** Upload cap **(default)**: the web app crops and scales to 512 × 512 first, so real uploads are far smaller. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** Largest accepted width or height **(default)**. */
export const MAX_AVATAR_DIMENSION = 4096;
/** The size the web app crops avatars to before uploading **(default)**. */
export const AVATAR_UPLOAD_SIZE = 512;

// ---- Profiles and the directory (Identity §4.7, §4.10, §6) ----------------------------------------

export const groupRefSchema = z.object({ id: ulidSchema, name: z.string(), handle: z.string().nullable() });
export type GroupRef = z.infer<typeof groupRefSchema>;

/** A person as the directory and the profile card show them (Identity §4.10: visible to every member). */
export const memberProfileSchema = z.object({
  id: ulidSchema,
  displayName: z.string(),
  handle: z.string().nullable(),
  email: z.string(),
  /** Same-origin URL of the avatar (changes with each upload), or null for initials. */
  avatarUrl: z.string().nullable(),
  jobTitle: z.string().nullable(),
  team: z.string().nullable(),
  pronouns: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  timezone: z.string(),
  workingHours: workingHoursSchema,
  /** True while the member hasn't set their own hours (the default is shown). */
  workingHoursDefaulted: z.boolean(),
  region: z.string().nullable(),
  status: memberStatusSchema.nullable(),
  /** Disabled members appear under the Deactivated filter (Identity §4.10). */
  deactivated: z.boolean(),
  /** The member's groups (M1e), by name. */
  groups: z.array(groupRefSchema),
});
export type MemberProfile = z.infer<typeof memberProfileSchema>;

/** `GET /api/me/profile`: the member's own profile, plus what the settings page needs. */
export const myProfileSchema = memberProfileSchema.extend({
  onboardedAt: z.number().int().nullable(),
  /** Handle changes still allowed in the current 30-day window (Platform §8). */
  handleChangesLeft: z.number().int().nonnegative(),
});
export type MyProfile = z.infer<typeof myProfileSchema>;

/**
 * `PATCH /api/me/profile`. Every field is optional; optional text fields take null or "" to clear.
 * `onboarded: true` records that the profile setup step was completed (Identity §4.3).
 */
export const updateProfileBodySchema = z.strictObject({
  displayName: displayNameSchema.optional(),
  handle: z.string().max(64).transform(normaliseHandle).optional(),
  timezone: timeZoneSchema.optional(),
  workingHours: workingHoursInputSchema.optional(),
  region: regionSchema.nullable().optional(),
  jobTitle: optionalText(MAX_JOB_TITLE_LENGTH).optional(),
  team: optionalText(MAX_TEAM_LENGTH).optional(),
  pronouns: optionalText(MAX_PRONOUNS_LENGTH).optional(),
  phone: optionalText(MAX_PHONE_LENGTH).optional(),
  location: optionalText(MAX_LOCATION_LENGTH).optional(),
  onboarded: z.literal(true).optional(),
});
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;

export const DIRECTORY_FILTERS = ["active", "deactivated"] as const;
export const directoryFilterSchema = z.enum(DIRECTORY_FILTERS);
export type DirectoryFilter = z.infer<typeof directoryFilterSchema>;
export const DIRECTORY_PAGE_SIZE = 50;
export const MAX_DIRECTORY_QUERY_LENGTH = 100;

/**
 * `GET /api/members?q=&filter=&group=&cursor=&limit=` (query string, validated on the Worker). `q` also
 * matches group names and handles, and `group` keeps members of one group (Identity §4.10; M1e).
 */
export const directoryQuerySchema = z.strictObject({
  q: z.string().trim().max(MAX_DIRECTORY_QUERY_LENGTH).optional(),
  filter: directoryFilterSchema.default("active"),
  group: ulidSchema.optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(DIRECTORY_PAGE_SIZE),
});
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;

export const directoryPageSchema = z.object({
  members: z.array(memberProfileSchema),
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type DirectoryPage = z.infer<typeof directoryPageSchema>;

/** `PUT /api/me/status` and `DELETE /api/me/status` answer with the status as now stored. */
export const statusResultSchema = z.object({ status: memberStatusSchema.nullable() });
export type StatusResult = z.infer<typeof statusResultSchema>;

/** `PUT /api/me/avatar` and `DELETE /api/me/avatar`. */
export const avatarResultSchema = z.object({ avatarUrl: z.string().nullable() });
export type AvatarResult = z.infer<typeof avatarResultSchema>;
