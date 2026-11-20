import { MAX_AVATAR_DIMENSION, type AvatarContentType } from "@officebox/shared";

/**
 * Avatar image checks (Identity §4.7, TDD §8.3; M1d). Pure: bytes in, a verdict out.
 *
 * The type is decided by the file's **own bytes**, never by its name or the request's `Content-Type`:
 * PNG, JPEG or WebP only. Beyond the magic bytes, each format's container is walked to its end, so a
 * file is accepted only if it is one well-formed image **and nothing else**: data appended after PNG's
 * `IEND`, JPEG's `EOI` or past the RIFF size (the classic image + HTML/ZIP/script polyglot) is refused,
 * as are truncated files, SVG, GIF, HTML and anything unrecognised. Width and height must be readable
 * and between 1 and {@link MAX_AVATAR_DIMENSION}.
 *
 * This doesn't make an image harmless to a decoder (that's the browser's job); it makes sure what we
 * store and serve is the type we say it is. Serving adds the rest: the sniffed `Content-Type`,
 * `nosniff`, `Content-Security-Policy: sandbox` and `Content-Disposition: inline` with an image name
 * (TDD §8.3).
 */

export type ImageCheck =
  | { ok: true; type: AvatarContentType; extension: "png" | "jpg" | "webp"; width: number; height: number }
  | { ok: false; reason: "unsupported_type" | "malformed" | "dimensions" };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((b, i) => bytes[at + i] === b);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) + b[at + 1]!;
const u32le = (b: Uint8Array, at: number) =>
  b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + ((b[at + 3]! << 24) >>> 0);
const u24le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16);
const u16le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8);

function withDimensions(
  type: AvatarContentType,
  extension: "png" | "jpg" | "webp",
  width: number,
  height: number,
): ImageCheck {
  if (width < 1 || height < 1 || width > MAX_AVATAR_DIMENSION || height > MAX_AVATAR_DIMENSION) {
    return { ok: false, reason: "dimensions" };
  }
  return { ok: true, type, extension, width, height };
}

/** PNG: signature, IHDR first, then length-type-data-CRC chunks, ending exactly at IEND. */
function checkPng(bytes: Uint8Array): ImageCheck {
  if (bytes.length < 8 + 25 + 12) return { ok: false, reason: "malformed" };
  if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") return { ok: false, reason: "malformed" };
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  let offset = 8;
  let sawData = false;
  for (;;) {
    if (offset + 12 > bytes.length) return { ok: false, reason: "malformed" };
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return { ok: false, reason: "malformed" };
    const end = offset + 12 + length;
    if (end > bytes.length) return { ok: false, reason: "malformed" };
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      // Nothing may follow IEND (appended payloads), and an image needs pixel data.
      if (length !== 0 || end !== bytes.length || !sawData) return { ok: false, reason: "malformed" };
      return withDimensions("image/png", "png", width, height);
    }
    offset = end;
  }
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * JPEG: SOI, then marker segments up to SOS (one of them a frame header with the dimensions), then
 * entropy-coded data, ending exactly at EOI. Restart markers and stuffed bytes inside the scan data are
 * skipped; progressive files (several scans) are followed scan by scan.
 */
function checkJpeg(bytes: Uint8Array): ImageCheck {
  if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    return { ok: false, reason: "malformed" };
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let frame = false;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return { ok: false, reason: "malformed" };
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      return frame && offset + 2 === bytes.length
        ? withDimensions("image/jpeg", "jpg", width, height)
        : { ok: false, reason: "malformed" };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return { ok: false, reason: "malformed" };
    const length = u16be(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return { ok: false, reason: "malformed" };
    if (SOF_MARKERS.has(marker)) {
      if (length < 7) return { ok: false, reason: "malformed" };
      height = u16be(bytes, offset + 5);
      width = u16be(bytes, offset + 7);
      frame = true;
    }
    offset += 2 + length;
    if (marker === 0xda) {
      if (!frame) return { ok: false, reason: "malformed" };
      // Entropy-coded data: runs until a marker that isn't a stuffed 0x00 or a restart marker.
      while (offset + 1 < bytes.length) {
        if (bytes[offset] === 0xff) {
          const next = bytes[offset + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        offset += 1;
      }
    }
  }
  return { ok: false, reason: "malformed" };
}

/** WebP: a RIFF container whose size covers the file exactly, with a VP8, VP8L or VP8X first chunk. */
function checkWebp(bytes: Uint8Array): ImageCheck {
  if (bytes.length < 30) return { ok: false, reason: "malformed" };
  const riffSize = u32le(bytes, 4);
  if (riffSize + 8 !== bytes.length || riffSize % 2 !== 0) return { ok: false, reason: "malformed" };
  // Walk the chunks to the end (each padded to an even length), so nothing hides past the last one.
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return { ok: false, reason: "malformed" };
    const size = u32le(bytes, offset + 4);
    offset += 8 + size + (size % 2);
    if (offset > bytes.length) return { ok: false, reason: "malformed" };
  }
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return withDimensions("image/webp", "webp", u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return { ok: false, reason: "malformed" };
    const bits = u32le(bytes, 21);
    return withDimensions("image/webp", "webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8 ") {
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return { ok: false, reason: "malformed" };
    return withDimensions("image/webp", "webp", u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  return { ok: false, reason: "malformed" };
}

/** Decides what an uploaded avatar is from its bytes alone. */
export function checkAvatarImage(bytes: Uint8Array): ImageCheck {
  if (startsWith(bytes, PNG_SIGNATURE)) return checkPng(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return checkJpeg(bytes);
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP") return checkWebp(bytes);
  return { ok: false, reason: "unsupported_type" };
}
