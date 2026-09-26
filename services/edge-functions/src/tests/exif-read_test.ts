// US-3518 / US-3520: provenance EXIF is read from the photo bytes on the
// server, never GPS, and the client-reported copy is tagged and GPS-free.
import { assert, assertEquals } from "@std/assert";
import { readExifFromBytes, sanitizeExif } from "../lib/exif-read.ts";

// Build a little-endian TIFF block: IFD0 {Make, Model, ExifIFD ptr, GPS ptr},
// Exif IFD {DateTimeOriginal}, GPS IFD {LatitudeRef, Latitude}. Then wrap it
// in a JPEG APP1 "Exif" segment.
function jpegWithExif(opts: { gps: boolean }): Uint8Array {
  const strings = {
    make: "Apple\0",
    model: "iPhone 14 Pro\0",
    dto: "2026:09:20 10:00:00\0",
  };
  const t: number[] = [];
  const u16 = (v: number) => t.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v: number) =>
    t.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const entry = (tag: number, type: number, count: number, value: number) => {
    u16(tag);
    u16(type);
    u32(count);
    u32(value);
  };

  // Layout (offsets from the TIFF start):
  //   0   header (8)
  //   8   IFD0: 2 + 4*12 + 4 = 54 -> ends at 62
  //   62  Exif IFD: 2 + 12 + 4 = 18 -> ends at 80
  //   80  GPS IFD: 2 + 12 + 4 = 18 -> ends at 98
  //   98  strings
  const ifd0 = 8, exifIfd = 62, gpsIfd = 80, data = 98;
  const makeOff = data;
  const modelOff = makeOff + strings.make.length;
  const dtoOff = modelOff + strings.model.length;

  t.push(0x49, 0x49); // "II"
  u16(0x002a);
  u32(ifd0);
  u16(4);
  entry(0x010f, 2, strings.make.length, makeOff);
  entry(0x0110, 2, strings.model.length, modelOff);
  entry(0x8769, 4, 1, exifIfd);
  entry(0x8825, 4, 1, opts.gps ? gpsIfd : 0);
  u32(0);
  u16(1);
  entry(0x9003, 2, strings.dto.length, dtoOff);
  u32(0);
  u16(1);
  entry(0x0001, 2, 2, 0x4e); // LatitudeRef "N" inline
  u32(0);
  for (const s of [strings.make, strings.model, strings.dto]) {
    for (const ch of s) t.push(ch.charCodeAt(0));
  }

  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
  const segLen = 2 + exifHeader.length + t.length;
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    (segLen >> 8) & 0xff,
    segLen & 0xff,
    ...exifHeader,
    ...t,
    0xff,
    0xd9,
  ]);
}

Deno.test("US-3518: reads make, model and capture time from the bytes, tagged server", () => {
  const exif = readExifFromBytes(jpegWithExif({ gps: true }));
  assertEquals(exif, {
    source: "server",
    make: "Apple",
    model: "iPhone 14 Pro",
    dateTimeOriginal: "2026:09:20 10:00:00",
  });
});

Deno.test("US-3520: a GPS IFD in the file is never read", () => {
  const exif = readExifFromBytes(jpegWithExif({ gps: true }));
  assert(exif !== null);
  assertEquals("gps" in exif, false);
});

Deno.test("US-3518: non-JPEG, truncated or EXIF-less bytes answer null", () => {
  assertEquals(
    readExifFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    null,
  );
  assertEquals(
    readExifFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
    null,
  );
  const full = jpegWithExif({ gps: false });
  assertEquals(readExifFromBytes(full.slice(0, 20)), null);
  assertEquals(readExifFromBytes(new Uint8Array(0)), null);
});

Deno.test("US-3520: the client-reported EXIF drops GPS and is tagged client", () => {
  const out = sanitizeExif(JSON.stringify({
    make: "Apple",
    model: "iPhone 14 Pro",
    dateTimeOriginal: "2026:09:20 10:00:00",
    gps: { latitude: 41.6, longitude: -93.6 },
  }));
  assertEquals(out, {
    source: "client",
    make: "Apple",
    model: "iPhone 14 Pro",
    dateTimeOriginal: "2026:09:20 10:00:00",
  });
});

Deno.test("US-3520: GPS alone leaves nothing to store", () => {
  assertEquals(
    sanitizeExif(JSON.stringify({ gps: { latitude: 1, longitude: 2 } })),
    null,
  );
  assertEquals(sanitizeExif("not json"), null);
  assertEquals(sanitizeExif(undefined), null);
});
