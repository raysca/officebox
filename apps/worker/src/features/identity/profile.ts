import {
  apiError,
  effectiveStatus,
  err,
  MAX_STATUS_DURATION_MS,
  ok,
  parseWorkingHours,
  type ApiError,
  type DirectoryPage,
  type DirectoryQuery,
  type MemberProfile,
  type MemberStatus,
  type MyProfile,
  type Result,
  type SetStatusBody,
  type UpdateProfileBody,
} from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk, type SqlValue } from "../../core/db";
import { avatarUrl } from "./avatar";
import { groupsOfUsers } from "./groups";
import { handleChangeAllowance, prepareHandleChange, runHandleBatch } from "./handles";

/**
 * Profiles and the member directory (M1d; Identity §4.7, §4.10, §6; Permissions §4.6).
 *
 * Routes ask the permission engine first (`profile.view`, `profile.edit`, `status.edit`,
 * `handle.change`, `directory.view`); these functions only read and write. Profile columns live on
 * `users` (Identity §5, folded into the baseline in 0008); better-auth can't write them
 * (`additionalFields` with `input: false`).
 *
 * - **Who appears:** active members, and disabled ones under the Deactivated filter. Deleted members and
 *   the reserved `system` rows never do (Identity §4.8, §4.10).
 * - **Status** is stored with its expiry and hidden once it passes, on every read; the member's UserHub
 *   also clears it from live presence at that moment (realtime `refreshStatus`).
 * - **Working hours** not yet set read as the Mon–Fri 09:00–17:00 default, flagged as defaulted.
 */

const PROFILE_COLUMNS = `id, email, display_name, handle, avatar_key, timezone, working_hours, region, job_title, team,
  pronouns, phone, location, status_emoji, status_text, status_expires_at, status, onboarded_at`;

interface ProfileRow {
  id: string;
  email: string | null;
  display_name: string;
  handle: string | null;
  avatar_key: string | null;
  timezone: string | null;
  working_hours: string | null;
  region: string | null;
  job_title: string | null;
  team: string | null;
  pronouns: string | null;
  phone: string | null;
  location: string | null;
  status_emoji: string | null;
  status_text: string | null;
  status_expires_at: number | null;
  status: string;
  onboarded_at: number | null;
}

function storedStatus(row: ProfileRow, now: number): MemberStatus | null {
  return effectiveStatus({ emoji: row.status_emoji, text: row.status_text, expiresAt: row.status_expires_at }, now);
}

type GroupRefs = MemberProfile["groups"];

function toProfile(row: ProfileRow, now: number, groups: GroupRefs = []): MemberProfile {
  const hours = parseWorkingHours(row.working_hours);
  return {
    id: row.id,
    displayName: row.display_name,
    handle: row.handle,
    email: row.email ?? "",
    avatarUrl: avatarUrl(row.id, row.avatar_key),
    jobTitle: row.job_title,
    team: row.team,
    pronouns: row.pronouns,
    phone: row.phone,
    location: row.location,
    timezone: row.timezone ?? "UTC",
    workingHours: hours.hours,
    workingHoursDefaulted: hours.defaulted,
    region: row.region,
    status: storedStatus(row, now),
    deactivated: row.status === "disabled",
    groups,
  };
}

async function profileRow(d1: D1Database, userId: string): Promise<ProfileRow | null> {
  return expectOk(
    await new Database(d1).first<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`, userId),
  );
}

/** `GET /members/:id`: an active or disabled member, or null (deleted, reserved or unknown). */
export async function getMember(ctx: CoreContext, userId: string): Promise<MemberProfile | null> {
  const row = await profileRow(ctx.env.DB, userId);
  if (!row || row.email === null || (row.status !== "active" && row.status !== "disabled")) return null;
  const groups = await groupsOfUsers(ctx.env.DB, [row.id]);
  return toProfile(row, ctx.now(), groups.get(row.id));
}

/** `GET /me/profile`. */
export async function getMyProfile(ctx: CoreContext, userId: string): Promise<Result<MyProfile, ApiError>> {
  const row = await profileRow(ctx.env.DB, userId);
  if (!row || row.status !== "active" || row.email === null) {
    return err(apiError("unauthenticated", "Sign in to continue."));
  }
  const allowance = await handleChangeAllowance(ctx.env.DB, userId, ctx.now());
  const groups = await groupsOfUsers(ctx.env.DB, [row.id]);
  return ok({
    ...toProfile(row, ctx.now(), groups.get(row.id)),
    onboardedAt: row.onboarded_at,
    handleChangesLeft: allowance.left,
  });
}

/** What a profile edit changed that others react to (the time zone feeds availability). */
export interface ProfileUpdate {
  profile: MyProfile;
  timezoneChanged: boolean;
  handleChanged: boolean;
}

/**
 * `PATCH /me/profile`. A handle change (checked first: its own rules and conflicts) and the other
 * fields are written in one D1 batch, so either the whole edit applies or none of it does.
 */
export async function updateProfile(
  ctx: CoreContext,
  userId: string,
  body: UpdateProfileBody,
): Promise<Result<ProfileUpdate, ApiError>> {
  const now = ctx.now();
  const before = await profileRow(ctx.env.DB, userId);
  if (!before || before.status !== "active") return err(apiError("unauthenticated", "Sign in to continue."));

  const plan = body.handle !== undefined ? await prepareHandleChange(ctx.env.DB, userId, body.handle, now) : ok(null);
  if (!plan.ok) return plan;

  const sets: string[] = [];
  const params: SqlValue[] = [];
  const set = (column: string, value: SqlValue) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (body.displayName !== undefined) set("display_name", body.displayName);
  if (body.timezone !== undefined) set("timezone", body.timezone);
  if (body.workingHours !== undefined) set("working_hours", JSON.stringify(body.workingHours));
  if (body.region !== undefined) set("region", body.region);
  if (body.jobTitle !== undefined) set("job_title", body.jobTitle);
  if (body.team !== undefined) set("team", body.team);
  if (body.pronouns !== undefined) set("pronouns", body.pronouns);
  if (body.phone !== undefined) set("phone", body.phone);
  if (body.location !== undefined) set("location", body.location);
  if (body.onboarded) {
    sets.push("onboarded_at = COALESCE(onboarded_at, ?)");
    params.push(now);
  }
  // With a handle change, the other fields go in the same UPDATE as the handle copy, conditional on the
  // change applying: either all apply, or (a lost handle race, a concurrent change) none do, so a failed
  // save never writes fields or uses up a handle change.
  if (plan.value) {
    const applied = await runHandleBatch(ctx.env.DB, plan.value, { sets, params });
    if (!applied.ok) return applied;
  } else if (sets.length > 0) {
    set("updated_at", now);
    expectOk(
      await new Database(ctx.env.DB).run(
        `UPDATE users SET ${sets.join(", ")} WHERE id = ? AND status = 'active'`,
        ...params,
        userId,
      ),
    );
  }
  const handleChanged = plan.value !== null;
  const profile = await getMyProfile(ctx, userId);
  if (!profile.ok) return profile;
  const timezoneChanged = body.timezone !== undefined && body.timezone !== (before.timezone ?? "UTC");
  return ok({ profile: profile.value, timezoneChanged, handleChanged });
}

/**
 * `PUT /me/status` (Identity §4.7). An expiry must be in the future and within a year **(default)**.
 * Emoji and text both empty clears the status (and its expiry).
 */
export async function setStatus(
  ctx: CoreContext,
  userId: string,
  body: SetStatusBody,
): Promise<Result<MemberStatus | null, ApiError>> {
  const now = ctx.now();
  const clearing = body.emoji === null && body.text === null;
  const expiresAt = clearing ? null : body.expiresAt;
  if (expiresAt !== null && (expiresAt <= now || expiresAt > now + MAX_STATUS_DURATION_MS)) {
    const message = "Choose a time in the next year.";
    return err(apiError("validation_failed", message, { fields: { expiresAt: [message] } }));
  }
  const written = expectOk(
    await new Database(ctx.env.DB).run(
      `UPDATE users SET status_emoji = ?, status_text = ?, status_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active'`,
      body.emoji,
      body.text,
      expiresAt,
      now,
      userId,
    ),
  );
  if (written.changes !== 1) return err(apiError("unauthenticated", "Sign in to continue."));
  return ok(clearing ? null : { emoji: body.emoji, text: body.text, expiresAt });
}

// ---- The directory (Identity §4.10) --------------------------------------------------------------

/** The cursor is opaque to clients: the last row's sort key, base64url-encoded JSON. */
function encodeCursor(name: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([name, id]));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") {
      return [value[0], value[1]];
    }
  } catch {
    // fall through
  }
  return null;
}

/** A LIKE pattern matching `text` anywhere, with LIKE's wildcards escaped. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * `GET /members` (Identity §4.10): search by name, handle, email, title, team or group (a group's name or
 * handle, M1e), filter by group (M1e), active members by default or the Deactivated filter, sorted by
 * name, paged with a keyset cursor. Matching ignores case for ASCII letters (SQLite LIKE) **(default)**.
 */
export async function listDirectory(ctx: CoreContext, query: DirectoryQuery): Promise<Result<DirectoryPage, ApiError>> {
  const where = ["status = ?", "email IS NOT NULL"];
  const params: SqlValue[] = [query.filter === "deactivated" ? "disabled" : "active"];
  const q = query.q?.trim();
  if (q) {
    const text = q.replace(/^@/, "").toLowerCase();
    const pattern = containsPattern(text);
    const columns = ["lower(display_name)", "handle", "email_normalised", "lower(job_title)", "lower(team)"];
    const inGroup = `EXISTS (SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.user_id = users.id AND g.deleted_at IS NULL
          AND (lower(g.name) LIKE ? ESCAPE '\\' OR g.handle LIKE ? ESCAPE '\\'))`;
    where.push(`(${[...columns.map((column) => `${column} LIKE ? ESCAPE '\\'`), inGroup].join(" OR ")})`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (query.group) {
    where.push(
      `EXISTS (SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.user_id = users.id AND gm.group_id = ? AND g.deleted_at IS NULL)`,
    );
    params.push(query.group);
  }
  if (query.cursor !== undefined) {
    const after = decodeCursor(query.cursor);
    if (!after)
      return err(apiError("validation_failed", "The cursor is not valid.", { fields: { cursor: ["Invalid."] } }));
    where.push("(display_name COLLATE NOCASE > ? OR (display_name COLLATE NOCASE = ? AND id > ?))");
    params.push(after[0], after[0], after[1]);
  }
  const rows = expectOk(
    await new Database(ctx.env.DB).all<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM users WHERE ${where.join(" AND ")}
        ORDER BY display_name COLLATE NOCASE, id LIMIT ?`,
      ...params,
      query.limit + 1,
    ),
  );
  const now = ctx.now();
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const groups = await groupsOfUsers(
    ctx.env.DB,
    page.map((row) => row.id),
  );
  return ok({
    members: page.map((row) => toProfile(row, now, groups.get(row.id))),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.display_name, last.id) : null,
  });
}
