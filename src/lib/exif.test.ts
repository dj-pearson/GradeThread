import { describe, it, expect } from "vitest";
import { readCaptureTime } from "./exif";

// Builds a minimal but structurally-valid JPEG carrying an Exif APP1 segment
// with a single DateTime tag, so we can exercise the parser without binary
// fixture files. `tag` lets us pick DateTimeOriginal (0x9003) vs Digitized.
function buildExifJpeg(dateString: string, tag = 0x9003, little = true): Uint8Array {
  // TIFF block, offsets relative to the start of the TIFF header.
  const enc = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));
  const ascii = [...enc(dateString), 0]; // NUL-terminated
  const strLen = ascii.length;

  const tiff: number[] = [];
  const u16 = (n: number) =>
    little ? [n & 0xff, (n >> 8) & 0xff] : [(n >> 8) & 0xff, n & 0xff];
  const u32 = (n: number) =>
    little
      ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
      : [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

  // Layout (offsets from TIFF start):
  //  0: header (8 bytes), IFD0 at 8
  //  8: IFD0 (count=1, one ExifIFD-pointer entry, next=0) → 18 bytes, ends 26
  // 26: ExifIFD (count=1, one DateTime entry, next=0) → 18 bytes, ends 44
  // 44: the date string
  const EXIF_IFD_OFFSET = 26;
  const STR_OFFSET = 44;

  // TIFF header
  tiff.push(...(little ? enc("II") : enc("MM")));
  tiff.push(...u16(0x2a));
  tiff.push(...u32(8)); // IFD0 offset

  // IFD0: one entry → Exif IFD pointer (tag 0x8769, type LONG=4, count 1)
  tiff.push(...u16(1));
  tiff.push(...u16(0x8769), ...u16(4), ...u32(1), ...u32(EXIF_IFD_OFFSET));
  tiff.push(...u32(0)); // next IFD

  // Exif IFD: one entry → DateTime (type ASCII=2, count strLen)
  tiff.push(...u16(1));
  tiff.push(...u16(tag), ...u16(2), ...u32(strLen), ...u32(STR_OFFSET));
  tiff.push(...u32(0)); // next IFD

  // The date string
  tiff.push(...ascii);

  // APP1 segment = "Exif\0\0" + TIFF block
  const exifHeader = [...enc("Exif"), 0, 0];
  const app1Body = [...exifHeader, ...tiff];
  const app1Len = app1Body.length + 2; // length field includes its own 2 bytes

  const jpeg: number[] = [
    0xff, 0xd8, // SOI
    0xff, 0xe1, // APP1
    (app1Len >> 8) & 0xff, app1Len & 0xff,
    ...app1Body,
    0xff, 0xd9, // EOI
  ];
  return new Uint8Array(jpeg);
}

function fileFrom(bytes: Uint8Array, lastModified = 0): File {
  return new File([bytes], "test.jpg", { type: "image/jpeg", lastModified });
}

describe("readCaptureTime", () => {
  it("reads DateTimeOriginal from EXIF (little-endian)", async () => {
    const file = fileFrom(buildExifJpeg("2021:07:15 14:30:00", 0x9003, true));
    const result = await readCaptureTime(file);
    expect(result).toEqual(new Date(2021, 6, 15, 14, 30, 0));
  });

  it("reads DateTimeOriginal from EXIF (big-endian)", async () => {
    const file = fileFrom(buildExifJpeg("2019:01:02 03:04:05", 0x9003, false));
    const result = await readCaptureTime(file);
    expect(result).toEqual(new Date(2019, 0, 2, 3, 4, 5));
  });

  it("falls back to DateTimeDigitized when Original is absent", async () => {
    const file = fileFrom(buildExifJpeg("2022:12:25 09:00:00", 0x9004, true));
    const result = await readCaptureTime(file);
    expect(result).toEqual(new Date(2022, 11, 25, 9, 0, 0));
  });

  it("falls back to lastModified for a photo without EXIF", async () => {
    const noExif = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI only
    const mtime = Date.UTC(2020, 5, 1, 12, 0, 0);
    const file = fileFrom(noExif, mtime);
    const result = await readCaptureTime(file);
    expect(result).toEqual(new Date(mtime));
  });

  it("returns null for a corrupt file with no usable timestamp", async () => {
    // Random bytes (not a JPEG) and a zero lastModified → nothing to read.
    const garbage = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
    const file = fileFrom(garbage, 0);
    const result = await readCaptureTime(file);
    expect(result).toBeNull();
  });

  it("ignores a zeroed placeholder EXIF date and falls back", async () => {
    const mtime = Date.UTC(2023, 0, 1, 0, 0, 0);
    const file = fileFrom(buildExifJpeg("0000:00:00 00:00:00", 0x9003, true), mtime);
    const result = await readCaptureTime(file);
    expect(result).toEqual(new Date(mtime));
  });
});
