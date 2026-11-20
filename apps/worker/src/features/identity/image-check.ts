import { MAX_AVATAR_DIMENSION, type AvatarContentType } from "@officebox/shared";

/**
 * Avatar image checks (Identity §4.7, TDD §8.3; M1d). Pure: bytes in, a verdict and cleaned bytes out.
 *
 * - **Type from the bytes:** decided by the file's own bytes, never by its name or the request's
 *   `Content-Type`: PNG, JPEG or WebP only. SVG, GIF, HTML and anything unrecognised are refused.
 * - **Structure:** each format's container is walked to its end, so truncated files, JPEGs with more
 *   than one frame header, and data **appended outside the container** (after PNG's `IEND`, JPEG's
 *   `EOI` or past the RIFF size: the common image + HTML/ZIP polyglot) are refused. Width and height
 *   must be readable and between 1 and {@link MAX_AVATAR_DIMENSION}.
 * - **Metadata stripped:** the stored copy drops what can carry text but isn't needed to draw the image:
 *   PNG text, `eXIf`, `tIME` and unknown ancillary chunks; JPEG `COM` and `APPn` segments other than
 *   APP0 (JFIF), APP2 (ICC profile) and APP14 (Adobe colour transform); WebP `EXIF` and `XMP ` chunks.
 *   This removes EXIF/GPS location tags from direct API uploads too (the web app also re-encodes).
 *
 * What this does **not** do: decode pixels, or prove that the bytes inside chunks the image needs (pixel
 * data, an ICC profile) aren't also something else. A file can still be crafted to be a valid image
 * and contain other bytes within those. That's why serving is locked down independently: the sniffed
 * `Content-Type`, `nosniff`, `Content-Security-Policy: …; sandbox`, `Content-Disposition: inline` with an
 * image name and `Cross-Origin-Resource-Policy: same-origin` (TDD §8.3), so the browser only ever
 * treats it as an image.
 */

export type ImageCheck =
  | {
      ok: true;
      type: AvatarContentType;
      extension: "png" | "jpg" | "webp";
      width: number;
      height: number;
      /** The image with metadata removed: what gets stored. */
      bytes: Uint8Array;
    }
  | { ok: false; reason: "unsupported_type" | "malformed" | "dimensions" };

type Failure = Extract<ImageCheck, { ok: false }>;
const MALFORMED: Failure = { ok: false, reason: "malformed" };

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

/** Joins the kept byte ranges of `bytes`. */
function join(bytes: Uint8Array, ranges: readonly [number, number][]): Uint8Array {
  const out = new Uint8Array(ranges.reduce((n, [from, to]) => n + (to - from), 0));
  let at = 0;
  for (const [from, to] of ranges) {
    out.set(bytes.subarray(from, to), at);
    at += to - from;
  }
  return out;
}

function withDimensions(
  type: AvatarContentType,
  extension: "png" | "jpg" | "webp",
  width: number,
  height: number,
  bytes: Uint8Array,
): ImageCheck {
  if (width < 1 || height < 1 || width > MAX_AVATAR_DIMENSION || height > MAX_AVATAR_DIMENSION) {
    return { ok: false, reason: "dimensions" };
  }
  return { ok: true, type, extension, width, height, bytes };
}

/** PNG chunks kept: the critical ones, and the ancillary ones that change how the image is drawn. */
const PNG_KEPT = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "sBIT",
  "pHYs",
  "bKGD",
  "acTL",
  "fcTL",
  "fdAT",
]);

/** PNG: signature, IHDR first, then length-type-data-CRC chunks, ending exactly at IEND. */
function checkPng(bytes: Uint8Array): ImageCheck {
  if (bytes.length < 8 + 25 + 12) return MALFORMED;
  if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") return MALFORMED;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  const kept: [number, number][] = [[0, 8]];
  let offset = 8;
  let sawData = false;
  for (;;) {
    if (offset + 12 > bytes.length) return MALFORMED;
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return MALFORMED;
    const end = offset + 12 + length;
    if (end > bytes.length) return MALFORMED;
    if (type === "IDAT") sawData = true;
    if (PNG_KEPT.has(type)) kept.push([offset, end]);
    if (type === "IEND") {
      // Nothing may follow IEND (appended payloads), and an image needs pixel data.
      if (length !== 0 || end !== bytes.length || !sawData) return MALFORMED;
      return withDimensions("image/png", "png", width, height, join(bytes, kept));
    }
    offset = end;
  }
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** JPEG segments dropped from the stored copy: COM, and APPn except APP0, APP2 and APP14. */
const isDroppedJpegSegment = (marker: number) =>
  marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2 && marker !== 0xee);

/**
 * JPEG: SOI, then marker segments up to SOS (exactly one of them a frame header, with the dimensions),
 * then entropy-coded data, ending exactly at EOI. Restart markers and stuffed bytes inside the scan data
 * are skipped; progressive files (several scans) are followed scan by scan.
 */
function checkJpeg(bytes: Uint8Array): ImageCheck {
  if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    return MALFORMED;
  }
  const kept: [number, number][] = [[0, 2]];
  let offset = 2;
  let width = 0;
  let height = 0;
  let frame = false;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return MALFORMED;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      if (!frame || offset + 2 !== bytes.length) return MALFORMED;
      kept.push([offset, offset + 2]);
      return withDimensions("image/jpeg", "jpg", width, height, join(bytes, kept));
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push([offset, offset + 2]);
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return MALFORMED;
    const length = u16be(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return MALFORMED;
    if (SOF_MARKERS.has(marker)) {
      // One frame per image: a second frame header is a different (or smuggled) image.
      if (frame || length < 7) return MALFORMED;
      height = u16be(bytes, offset + 5);
      width = u16be(bytes, offset + 7);
      frame = true;
    }
    const segmentEnd = offset + 2 + length;
    if (marker !== 0xda) {
      if (!isDroppedJpegSegment(marker)) kept.push([offset, segmentEnd]);
      offset = segmentEnd;
      continue;
    }
    if (!frame) return MALFORMED;
    // Entropy-coded data: runs until a marker that isn't a stuffed 0x00 or a restart marker.
    let scanEnd = segmentEnd;
    while (scanEnd + 1 < bytes.length) {
      if (bytes[scanEnd] === 0xff) {
        const next = bytes[scanEnd + 1]!;
        if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
      }
      scanEnd += 1;
    }
    kept.push([offset, scanEnd]);
    offset = scanEnd;
  }
  return MALFORMED;
}

/** VP8X flag bits for metadata chunks that the stored copy drops. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

/** WebP: a RIFF container whose size covers the file exactly, with a VP8, VP8L or VP8X first chunk. */
function checkWebp(bytes: Uint8Array): ImageCheck {
  if (bytes.length < 30) return MALFORMED;
  const riffSize = u32le(bytes, 4);
  if (riffSize + 8 !== bytes.length || riffSize % 2 !== 0) return MALFORMED;
  // Walk the chunks to the end (each padded to an even length), so nothing hides past the last one.
  const kept: [number, number][] = [];
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return MALFORMED;
    const type = ascii(bytes, offset, 4);
    const size = u32le(bytes, offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length) return MALFORMED;
    if (type !== "EXIF" && type !== "XMP ") kept.push([offset, end]);
    offset = end;
  }
  const chunk = ascii(bytes, 12, 4);
  let width: number;
  let height: number;
  if (chunk === "VP8X") {
    width = u24le(bytes, 24) + 1;
    height = u24le(bytes, 27) + 1;
  } else if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return MALFORMED;
    const bits = u32le(bytes, 21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === "VP8 ") {
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return MALFORMED;
    width = u16le(bytes, 26) & 0x3fff;
    height = u16le(bytes, 28) & 0x3fff;
  } else {
    return MALFORMED;
  }
  const body = join(bytes, kept);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12));
  out.set(body, 12);
  // The RIFF size covers what's left; a VP8X header no longer claims the dropped metadata.
  const size = out.length - 8;
  out[4] = size & 0xff;
  out[5] = (size >>> 8) & 0xff;
  out[6] = (size >>> 16) & 0xff;
  out[7] = (size >>> 24) & 0xff;
  if (chunk === "VP8X") out[20] = out[20]! & ~(VP8X_EXIF | VP8X_XMP);
  return withDimensions("image/webp", "webp", width, height, out);
}

/** Decides what an uploaded avatar is from its bytes alone, and returns it with metadata removed. */
export function checkAvatarImage(bytes: Uint8Array): ImageCheck {
  if (startsWith(bytes, PNG_SIGNATURE)) return checkPng(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return checkJpeg(bytes);
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP") return checkWebp(bytes);
  return { ok: false, reason: "unsupported_type" };
}
