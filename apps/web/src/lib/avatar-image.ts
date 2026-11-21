import { AVATAR_UPLOAD_SIZE, type AvatarContentType } from "@officebox/shared";

/**
 * Crops a chosen picture to a centred square and scales it to {@link AVATAR_UPLOAD_SIZE} pixels on the
 * client (Identity §4.7: "cropped to a square on the client"), so uploads are small and every avatar
 * has the same shape. Re-encoding through a canvas also drops metadata (location tags in photos).
 * WebP where the browser can encode it, PNG otherwise.
 */
export async function squareAvatar(file: Blob): Promise<{ blob: Blob; type: AvatarContentType } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const side = Math.min(bitmap.width, bitmap.height);
  if (side < 1) return null;
  const target = Math.min(AVATAR_UPLOAD_SIZE, side);
  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, target, target);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  if (!blob) return null;
  // A browser that can't encode WebP answers with PNG.
  const type: AvatarContentType = blob.type === "image/webp" ? "image/webp" : "image/png";
  return { blob, type };
}
