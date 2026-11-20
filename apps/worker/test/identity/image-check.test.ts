import { describe, expect, it } from "vitest";
import { checkAvatarImage } from "../../src/features/identity/image-check";
import {
  concat,
  contains,
  GIF,
  HTML,
  jpeg,
  jpegWithMetadata,
  jpegWithTwoFrames,
  png,
  PNG_1X1,
  pngWithText,
  SVG,
  text,
  webp,
  webpWithExif,
} from "./images";

describe("avatar image checks (Identity §4.7, TDD §8.3)", () => {
  it("accepts a real PNG and reads its size", () => {
    expect(checkAvatarImage(PNG_1X1)).toEqual({
      ok: true,
      type: "image/png",
      extension: "png",
      width: 1,
      height: 1,
      bytes: PNG_1X1,
    });
  });

  it.each([
    ["PNG", png(512, 256), "image/png", 512, 256],
    ["JPEG", jpeg(300, 200), "image/jpeg", 300, 200],
    ["WebP", webp(640, 480), "image/webp", 640, 480],
  ] as const)("accepts a %s", (_name, bytes, type, width, height) => {
    expect(checkAvatarImage(bytes)).toMatchObject({ ok: true, type, width, height });
  });

  it.each([
    ["SVG", SVG],
    ["HTML", HTML],
    ["GIF", GIF],
    ["empty", new Uint8Array(0)],
    ["plain text", text("hello")],
  ])("refuses %s as an unsupported type", (_name, bytes) => {
    expect(checkAvatarImage(bytes)).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it.each([
    ["PNG + HTML appended", concat(PNG_1X1, HTML)],
    ["PNG + SVG appended", concat(png(2, 2), SVG)],
    ["JPEG + ZIP appended", concat(jpeg(2, 2), text("PK\u0003\u0004 payload"))],
    ["JPEG + HTML after an early EOI", concat(jpeg(2, 2), HTML, Uint8Array.from([0xff, 0xd9]))],
    ["WebP + HTML appended", concat(webp(2, 2), HTML)],
    ["truncated PNG", PNG_1X1.slice(0, PNG_1X1.length - 12)],
    ["truncated JPEG", jpeg(2, 2).slice(0, 30)],
    ["PNG signature then HTML", concat(PNG_1X1.slice(0, 8), HTML)],
    ["JPEG magic then HTML", concat(Uint8Array.from([0xff, 0xd8, 0xff]), HTML)],
    ["RIFF/WEBP magic then HTML", concat(text("RIFF\u0000\u0000\u0000\u0000WEBP"), HTML)],
  ])("refuses %s as malformed", (_name, bytes) => {
    expect(checkAvatarImage(bytes)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["too wide", png(4097, 10)],
    ["too tall", jpeg(10, 4097)],
    ["zero-sized", png(0, 10)],
  ])("refuses an image %s", (_name, bytes) => {
    expect(checkAvatarImage(bytes)).toEqual({ ok: false, reason: "dimensions" });
  });

  it("refuses a JPEG with two frame headers", () => {
    expect(checkAvatarImage(jpegWithTwoFrames())).toEqual({ ok: false, reason: "malformed" });
  });

  const PAYLOAD = "<script>alert(1)</script> GPS 51.5N";
  it.each([
    ["PNG tEXt and eXIf chunks", pngWithText(PAYLOAD), png(4, 4)],
    ["JPEG APP1 and COM segments", jpegWithMetadata(PAYLOAD), jpeg(4, 4)],
  ])("accepts an image with metadata in %s, and strips it", (_name, bytes, clean) => {
    const checked = checkAvatarImage(bytes);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(contains(bytes, "<script>")).toBe(true);
    expect(contains(checked.bytes, "<script>")).toBe(false);
    expect(checked.bytes).toEqual(clean);
    // The cleaned copy is itself a valid image of the same size.
    expect(checkAvatarImage(checked.bytes)).toMatchObject({ ok: true, width: 4, height: 4 });
  });

  it("strips a WebP EXIF chunk, fixing the RIFF size and the VP8X flag", () => {
    const bytes = webpWithExif(PAYLOAD);
    const checked = checkAvatarImage(bytes);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(contains(checked.bytes, "<script>")).toBe(false);
    expect(new DataView(checked.bytes.buffer).getUint32(4, true)).toBe(checked.bytes.length - 8);
    expect(checked.bytes[20]! & 0x08).toBe(0);
    expect(checkAvatarImage(checked.bytes)).toMatchObject({ ok: true, width: 4, height: 4 });
  });
});
