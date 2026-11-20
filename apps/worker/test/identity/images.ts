/** Test images built byte by byte (no binary fixtures in the repository). */

/** A real 1 × 1 PNG. */
export const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (ch) => ch.charCodeAt(0),
);

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));

/** A PNG with the given dimensions (CRCs zeroed: the check walks structure, it doesn't decode). */
export function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: number[]) => [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...chunk("IDAT", [0x78, 0x9c, 0x63, 0x00, 0x00]),
    ...chunk("IEND", []),
  ]);
}

/** A baseline JPEG skeleton: SOI, APP0, SOF0 with the dimensions, SOS, a little scan data, EOI. */
export function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...ascii("JFIF"),
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    0x12,
    0xff,
    0x00, // a stuffed 0xFF inside the scan data
    0x34,
    0xff,
    0xd0, // a restart marker
    0x56,
    0xff,
    0xd9,
  ]);
}

/** A lossless WebP (VP8L) header with the given dimensions. */
export function webp(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const data = [0x2f, ...u32le(bits), 0x00, 0x00, 0x00, 0x00, 0x00];
  const chunk = [...ascii("VP8L"), ...u32le(data.length), ...data];
  return Uint8Array.from([...ascii("RIFF"), ...u32le(4 + chunk.length), ...ascii("WEBP"), ...chunk]);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const text = (value: string) => new TextEncoder().encode(value);

export const SVG = text(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>',
);
export const HTML = text("<!doctype html><html><body><script>alert(document.cookie)</script></body></html>");
export const GIF = Uint8Array.from([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x3b]);

/** A PNG with a `tEXt` chunk and an `eXIf` chunk before IEND, each carrying `payload`. */
export function pngWithText(payload: string): Uint8Array {
  const base = png(4, 4);
  const chunk = (type: string, body: number[]) => [...u32be(body.length), ...ascii(type), ...body, 0, 0, 0, 0];
  return concat(
    base.slice(0, base.length - 12),
    Uint8Array.from(chunk("tEXt", [...ascii("Comment"), 0, ...ascii(payload)])),
    Uint8Array.from(chunk("eXIf", ascii(payload))),
    base.slice(base.length - 12),
  );
}

/** A JPEG with an APP1 (EXIF/XMP) segment and a COM segment carrying `payload`, right after SOI. */
export function jpegWithMetadata(payload: string): Uint8Array {
  const base = jpeg(4, 4);
  const body = ascii(payload);
  const segment = (marker: number) => [
    0xff,
    marker,
    ((body.length + 2) >> 8) & 0xff,
    (body.length + 2) & 0xff,
    ...body,
  ];
  return concat(base.slice(0, 2), Uint8Array.from([...segment(0xe1), ...segment(0xfe)]), base.slice(2));
}

/** A JPEG with two frame headers (SOF0 twice). */
export function jpegWithTwoFrames(): Uint8Array {
  const base = jpeg(4, 4);
  // `jpeg()`'s SOF0 segment starts after SOI (2 bytes) and APP0 (18 bytes) and is 13 bytes long.
  return concat(base.slice(0, 33), base.slice(20, 33), base.slice(33));
}

/** An extended WebP (VP8X with the EXIF flag) with an EXIF chunk carrying `payload`, then a VP8L image. */
export function webpWithExif(payload: string): Uint8Array {
  const vp8x = [...ascii("VP8X"), ...u32le(10), 0x08, 0, 0, 0, 3, 0, 0, 3, 0, 0]; // 4 × 4
  const body = ascii(payload.length % 2 ? `${payload} ` : payload);
  const exif = [...ascii("EXIF"), ...u32le(body.length), ...body];
  const chunks = concat(Uint8Array.from(vp8x), Uint8Array.from(exif), webp(4, 4).slice(12));
  return concat(Uint8Array.from([...ascii("RIFF"), ...u32le(4 + chunks.length), ...ascii("WEBP")]), chunks);
}

/** Whether `needle` occurs in `bytes`. */
export function contains(bytes: Uint8Array, needle: string): boolean {
  return new TextDecoder("latin1").decode(bytes).includes(needle);
}
