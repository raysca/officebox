import {
  apiError,
  AVATAR_CONTENT_TYPES,
  err,
  FILE_CONTENT_SECURITY_POLICY,
  MAX_AVATAR_BYTES,
  ok,
  type ApiError,
  type Result,
} from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { readBodyBytes } from "../../core/errors";
import { ulid } from "../../core/ids";
import { checkAvatarImage } from "./image-check";

/**
 * Avatars in R2 (Identity §4.7, TDD §8.3; M1d).
 *
 * - **Keys:** `avatars/<userId>/<ulid>.<ext>` **(default)**. Each upload is a new object; `users.avatar_key`
 *   points at the current one and the previous object is deleted once the pointer has moved, so a
 *   failed write never leaves the member without an avatar. The ULID doubles as the URL's version, so
 *   browsers may cache an avatar privately and still see a new one at once.
 * - **Uploads** are the raw image bytes (`PUT /api/me/avatar`, `Content-Type` image/png, image/jpeg or
 *   image/webp), streamed with a {@link MAX_AVATAR_BYTES} cap. The type comes from the bytes
 *   (`image-check.ts`) and must agree with the declared `Content-Type`; SVG, HTML, GIF and polyglots
 *   are refused.
 * - **Downloads** (`GET /api/members/:id/avatar`) go through the permission engine (`profile.view`) and
 *   carry the sniffed type, `nosniff` (every response), `Content-Security-Policy: …; sandbox`,
 *   `Content-Disposition: inline` with an image file name, and `Cross-Origin-Resource-Policy:
 *   same-origin`.
 * - **Erasure:** {@link deleteAvatarObjects} removes every object under the member's prefix; member
 *   deletion (M1e) calls it, as Platform §3.1's erase list requires.
 */

const AVATAR_PREFIX = "avatars/";
const KEY_PATTERN = /^avatars\/([0-9A-HJKMNP-TV-Z]{26})\/([0-9A-HJKMNP-TV-Z]{26})\.(png|jpg|webp)$/;

/** The avatar's same-origin URL, versioned by the object's ULID, or null without one. */
export function avatarUrl(userId: string, key: string | null): string | null {
  if (!key) return null;
  const match = KEY_PATTERN.exec(key);
  return match ? `/api/members/${userId}/avatar?v=${match[2]}` : null;
}

const CONTENT_TYPE_FOR = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;

function unsupported(): ApiError {
  const message = "Choose a PNG, JPEG or WebP image.";
  return apiError("validation_failed", message, { reason: "avatar_type", fields: { avatar: [message] } });
}

async function currentKey(db: Database, userId: string): Promise<{ key: string | null } | null> {
  const row = expectOk(
    await db.first<{ avatar_key: string | null }>(
      "SELECT avatar_key FROM users WHERE id = ? AND status = 'active'",
      userId,
    ),
  );
  return row ? { key: row.avatar_key } : null;
}

/**
 * Points `users.avatar_key` at `next` (or null), compare-and-set on the key read, retried a few times
 * against a concurrent change by the same person. Returns the replaced key.
 */
async function swapKey(
  db: Database,
  userId: string,
  next: string | null,
  now: number,
): Promise<Result<string | null, ApiError>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await currentKey(db, userId);
    if (!current) return err(apiError("unauthenticated", "Sign in to continue."));
    const written = expectOk(
      await db.run(
        "UPDATE users SET avatar_key = ?, updated_at = ? WHERE id = ? AND status = 'active' AND avatar_key IS ?",
        next,
        now,
        userId,
        current.key,
      ),
    );
    if (written.changes === 1) return ok(current.key);
  }
  return err(apiError("conflict", "Your avatar changed at the same time. Try again."));
}

async function deleteObject(ctx: CoreContext, key: string | null): Promise<void> {
  if (!key) return;
  try {
    await ctx.env.FILES.delete(key);
  } catch (error) {
    // An orphaned object costs storage, not correctness; the erase on deletion sweeps the prefix.
    ctx.log.warn("avatar: old object not deleted", { error });
  }
}

/** `PUT /me/avatar`: checks the bytes, stores a new object and points the member at it. */
export async function uploadAvatar(
  ctx: CoreContext,
  userId: string,
  request: Request,
): Promise<Result<{ avatarUrl: string | null }, ApiError>> {
  const declared = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(declared)) return err(unsupported());
  const body = await readBodyBytes(request, MAX_AVATAR_BYTES);
  if (!body.ok) {
    if (body.error.code !== "payload_too_large") return body;
    const message = "Choose an image under 2 MB.";
    return err(apiError("payload_too_large", message, { reason: "avatar_size", fields: { avatar: [message] } }));
  }
  const checked = checkAvatarImage(body.value);
  if (!checked.ok) {
    if (checked.reason === "unsupported_type") return err(unsupported());
    const message =
      checked.reason === "dimensions"
        ? "Choose an image no larger than 4096 × 4096 pixels."
        : "That image couldn't be read. Try another file.";
    return err(
      apiError("validation_failed", message, { reason: `avatar_${checked.reason}`, fields: { avatar: [message] } }),
    );
  }
  // The declared type must be what the bytes are: a PNG sent as image/webp is refused too.
  if (checked.type !== declared) return err(unsupported());

  const key = `${AVATAR_PREFIX}${userId}/${ulid()}.${checked.extension}`;
  await ctx.env.FILES.put(key, body.value, {
    httpMetadata: { contentType: CONTENT_TYPE_FOR[checked.extension] },
    customMetadata: { userId },
  });
  const db = new Database(ctx.env.DB);
  let swapped: Result<string | null, ApiError>;
  try {
    swapped = await swapKey(db, userId, key, ctx.now());
  } catch (error) {
    await deleteObject(ctx, key);
    throw error;
  }
  if (!swapped.ok) {
    await deleteObject(ctx, key);
    return swapped;
  }
  await deleteObject(ctx, swapped.value);
  return ok({ avatarUrl: avatarUrl(userId, key) });
}

/** `DELETE /me/avatar`: back to initials. */
export async function removeAvatar(ctx: CoreContext, userId: string): Promise<Result<{ avatarUrl: null }, ApiError>> {
  const swapped = await swapKey(new Database(ctx.env.DB), userId, null, ctx.now());
  if (!swapped.ok) return swapped;
  await deleteObject(ctx, swapped.value);
  return ok({ avatarUrl: null });
}

/**
 * The avatar response for `GET /members/:id/avatar` (the caller has checked `profile.view`), or null
 * when the member has none or the object is missing.
 */
export async function avatarResponse(ctx: CoreContext, userId: string): Promise<Response | null> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ avatar_key: string | null }>(
      "SELECT avatar_key FROM users WHERE id = ?",
      userId,
    ),
  );
  const key = row?.avatar_key ?? null;
  const match = key ? KEY_PATTERN.exec(key) : null;
  // Only keys this module wrote, under this member's own prefix, are ever read.
  if (!key || !match || match[1] !== userId) return null;
  const object = await ctx.env.FILES.get(key);
  if (!object) return null;
  const extension = match[3] as keyof typeof CONTENT_TYPE_FOR;
  return new Response(object.body, {
    status: 200,
    headers: {
      // The type is fixed by the key's extension, which came from the sniffed bytes, never the client.
      "Content-Type": CONTENT_TYPE_FOR[extension],
      "Content-Length": String(object.size),
      "Content-Disposition": `inline; filename="avatar.${extension}"`,
      "Content-Security-Policy": FILE_CONTENT_SECURITY_POLICY,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      // Versioned URLs (?v=<ulid>): a new upload is a new URL. Private: never in shared caches (TDD §8.2).
      "Cache-Control": "private, max-age=86400",
    },
  });
}

/** Deletes every avatar object of a member (Platform §3.1 erase list; called by member deletion, M1e). */
export async function deleteAvatarObjects(bucket: R2Bucket, userId: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `${AVATAR_PREFIX}${userId}/`, cursor });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) await bucket.delete(keys);
    deleted += keys.length;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return deleted;
}
