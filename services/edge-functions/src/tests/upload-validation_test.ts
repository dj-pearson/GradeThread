// US-276: upload validation + EXIF/GPS strip unit tests. Pure byte logic.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  sniffImageFormat,
  validateImageUpload,
} from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";

// ── Fixtures ───────────────────────────────────────────────────────

// Minimal JPEG: SOI + APP0(JFIF) + APP1(EXIF w/ a GPS marker) + SOF0(2x2) +
// SOS + a couple data bytes + EOI.
function jpegWithExif(): Uint8Array {
  const out: number[] = [0xff, 0xd8]; // SOI
  // APP0 JFIF (length 16)
  out.push(0xff, 0xe0, 0x00, 0x10);
  out.push(...[0x4a, 0x46, 0x49, 0x46, 0x00]); // "JFIF\0"
  for (let i = 0; i < 9; i++) out.push(0x00);
  // APP1 EXIF carrying a recognizable GPS sentinel ("GPSDATA!")
  const exifPayload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const sentinel = [...new TextEncoder().encode("GPSDATA!")];
  const body = [...exifPayload, ...sentinel];
  const len = body.length + 2;
  out.push(0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...body);
  // SOF0: length 0x0B (11) = 2 len bytes + precision(1) + h(2) + w(2) +
  // numComponents(1) + 1 component descriptor(3). height=2, width=2.
  out.push(0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01);
  out.push(0x00, 0x00, 0x00); // single component descriptor
  // SOS + minimal scan data + EOI
  out.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  out.push(0x12, 0x34, 0xff, 0xd9);
  return new Uint8Array(out);
}

function pngWithExif(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]): number[] => {
    const len = data.length;
    const t = [...type].map((c) => c.charCodeAt(0));
    return [
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...t,
      ...data,
      0,
      0,
      0,
      0, // crc placeholder (not validated by the stripper)
    ];
  };
  // IHDR: width=2,height=2,bitdepth8,colortype2 + filler
  const ihdr = [0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0];
  const exif = [...new TextEncoder().encode("GPSDATA!")];
  return new Uint8Array([
    ...sig,
    ...chunk("IHDR", ihdr),
    ...chunk("eXIf", exif),
    ...chunk("IDAT", [1, 2, 3]),
    ...chunk("IEND", []),
  ]);
}

function webpHeader(): Uint8Array {
  // RIFF + size + WEBP + a VP8 chunk (so it sniffs as webp).
  const b = new Uint8Array(20);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x0c, 0, 0, 0], 4); // size
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  return b;
}

// ── sniffing ───────────────────────────────────────────────────────

Deno.test("sniff identifies jpeg/png/webp/heic", () => {
  assertEquals(sniffImageFormat(jpegWithExif()), "jpeg");
  assertEquals(sniffImageFormat(pngWithExif()), "png");
  assertEquals(sniffImageFormat(webpHeader()), "webp");
  const heic = new Uint8Array(16);
  heic.set([...new TextEncoder().encode("\0\0\0ftypheic")], 0);
  assertEquals(sniffImageFormat(heic), "heic");
});

Deno.test("sniff rejects non-images", () => {
  assertEquals(
    sniffImageFormat(new TextEncoder().encode("<svg xmlns=...")),
    null,
  );
  assertEquals(
    sniffImageFormat(new TextEncoder().encode("plain text here!!")),
    null,
  );
});

// ── validation ─────────────────────────────────────────────────────

Deno.test("validate accepts a real jpeg and reports dimensions", () => {
  const r = validateImageUpload(jpegWithExif());
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.format, "jpeg");
    assertEquals(r.contentType, "image/jpeg");
    assertEquals(r.width, 2);
    assertEquals(r.height, 2);
  }
});

Deno.test("validate reports png dimensions", () => {
  const r = validateImageUpload(pngWithExif());
  assert(r.ok);
  if (r.ok) assertEquals([r.width, r.height], [2, 2]);
});

Deno.test("validate rejects SVG (script-bearing)", () => {
  const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
  const r = validateImageUpload(svg);
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("SVG"));
});

Deno.test("validate rejects a renamed text/exe and empty files", () => {
  assert(
    !validateImageUpload(new TextEncoder().encode("not an image at all")).ok,
  );
  assert(
    !validateImageUpload(
      new Uint8Array([0x4d, 0x5a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    ).ok,
  );
  assert(!validateImageUpload(new Uint8Array(0)).ok);
});

Deno.test("validate enforces the byte-size cap", () => {
  const big = jpegWithExif();
  const r = validateImageUpload(big, { maxBytes: 4 });
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("too large"));
});

Deno.test("validate enforces an allowlist subset (no HEIC into private bucket)", () => {
  const heic = new Uint8Array(16);
  heic.set([...new TextEncoder().encode("\0\0\0ftypheic")], 0);
  const r = validateImageUpload(heic, { allow: ["jpeg", "png", "webp"] });
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("not allowed"));
});

Deno.test("validate enforces the max-dimension cap", () => {
  const png = pngWithExif();
  const r = validateImageUpload(png, { maxDimension: 1 }); // 2x2 > 1
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("too large"));
});

// ── US-529: WebP dimensions + min-resolution gate ──────────────────

// RIFF/WEBP container around a single chunk.
function webpContainer(fourcc: string, data: number[]): Uint8Array {
  const t = [...fourcc].map((c) => c.charCodeAt(0));
  const sz = data.length;
  const body = [
    0x57,
    0x45,
    0x42,
    0x50, // WEBP
    ...t,
    sz & 0xff,
    (sz >> 8) & 0xff,
    (sz >> 16) & 0xff,
    (sz >> 24) & 0xff,
    ...data,
  ];
  const full = new Uint8Array(8 + body.length);
  full.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  full[4] = body.length & 0xff;
  full[5] = (body.length >> 8) & 0xff;
  full.set(body, 8);
  return full;
}

function webpLossy(width: number, height: number): Uint8Array {
  // 3-byte frame tag + sync code 9D 01 2A + 14-bit LE width/height.
  return webpContainer("VP8 ", [
    0x00,
    0x00,
    0x00,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    (width >> 8) & 0x3f,
    height & 0xff,
    (height >> 8) & 0x3f,
  ]);
}

Deno.test("validate parses lossy VP8 webp dimensions", () => {
  const r = validateImageUpload(webpLossy(800, 600));
  assert(r.ok);
  if (r.ok) assertEquals([r.width, r.height], [800, 600]);
});

Deno.test("validate parses VP8L webp dimensions", () => {
  const bits = ((800 - 1) | ((600 - 1) << 14)) >>> 0;
  const r = validateImageUpload(
    webpContainer("VP8L", [
      0x2f,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      (bits >> 24) & 0xff,
      0x00,
    ]),
  );
  assert(r.ok);
  if (r.ok) assertEquals([r.width, r.height], [800, 600]);
});

Deno.test("validate parses VP8X webp canvas dimensions", () => {
  const w = 800 - 1;
  const h = 600 - 1;
  const r = validateImageUpload(
    webpContainer("VP8X", [
      0x00, // flags
      0x00,
      0x00,
      0x00, // reserved
      w & 0xff,
      (w >> 8) & 0xff,
      (w >> 16) & 0xff,
      h & 0xff,
      (h >> 8) & 0xff,
      (h >> 16) & 0xff,
    ]),
  );
  assert(r.ok);
  if (r.ok) assertEquals([r.width, r.height], [800, 600]);
});

Deno.test("minDimension rejects an unusably small image", () => {
  const r = validateImageUpload(pngWithExif(), { minDimension: 500 }); // 2x2
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("too small"));
});

Deno.test("minDimension passes when the longest side clears the floor", () => {
  // 800x600: longest side 800 >= 500 even though the short side is over 500 too;
  // also check a portrait crop where only ONE side clears the floor (600x300).
  assert(validateImageUpload(webpLossy(800, 600), { minDimension: 500 }).ok);
  assert(validateImageUpload(webpLossy(600, 300), { minDimension: 500 }).ok);
  assert(!validateImageUpload(webpLossy(400, 300), { minDimension: 500 }).ok);
});

Deno.test("minDimension fails open when dimensions aren't parseable", () => {
  // Truncated VP8 chunk (no sync code window) → dims unknown → size caps only.
  const r = validateImageUpload(webpHeader(), { minDimension: 500 });
  assert(r.ok);
});

// ── metadata stripping ─────────────────────────────────────────────

function contains(haystack: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (haystack[i + j] !== n[j]) continue outer;
    }
    return true;
  }
  return false;
}

Deno.test("strip removes JPEG EXIF/GPS (APP1) but keeps SOI + scan data", () => {
  const src = jpegWithExif();
  assert(contains(src, "GPSDATA!"), "fixture should embed GPS sentinel");
  const { bytes, stripped } = stripImageMetadata(src, "jpeg");
  assert(stripped);
  assert(!contains(bytes, "GPSDATA!"), "GPS sentinel must be gone");
  assertEquals([bytes[0], bytes[1]], [0xff, 0xd8]); // SOI preserved
  assert(contains(bytes, "JFIF")); // APP0 kept
  // EOI preserved
  assertEquals([bytes[bytes.length - 2], bytes[bytes.length - 1]], [
    0xff,
    0xd9,
  ]);
});

Deno.test("strip removes PNG eXIf chunk, keeps IHDR/IDAT/IEND", () => {
  const src = pngWithExif();
  assert(contains(src, "GPSDATA!"));
  const { bytes, stripped } = stripImageMetadata(src, "png");
  assert(stripped);
  assert(!contains(bytes, "GPSDATA!"));
  assert(
    contains(bytes, "IHDR") && contains(bytes, "IDAT") &&
      contains(bytes, "IEND"),
  );
  assert(!contains(bytes, "eXIf"));
});

Deno.test("strip removes WebP EXIF chunk and rewrites RIFF size", () => {
  // RIFF + WEBP + VP8 chunk(4 bytes) + EXIF chunk(with sentinel).
  const vp8data = [0xaa, 0xbb, 0xcc, 0xdd];
  const exif = [...new TextEncoder().encode("GPSDATA!")];
  const body: number[] = [0x57, 0x45, 0x42, 0x50]; // WEBP
  const chunk = (cc: string, data: number[]) => {
    const t = [...cc].map((c) => c.charCodeAt(0));
    const sz = data.length;
    return [
      t[0]!,
      t[1]!,
      t[2]!,
      t[3]!,
      sz & 0xff,
      (sz >> 8) & 0xff,
      (sz >> 16) & 0xff,
      (sz >> 24) & 0xff,
      ...data,
    ];
  };
  body.push(...chunk("VP8 ", vp8data));
  body.push(...chunk("EXIF", exif));
  const full = new Uint8Array(8 + body.length);
  full.set([0x52, 0x49, 0x46, 0x46], 0);
  const sz = body.length;
  full[4] = sz & 0xff;
  full[5] = (sz >> 8) & 0xff;
  full.set(body, 8);

  assertEquals(sniffImageFormat(full), "webp");
  const { bytes, stripped } = stripImageMetadata(full, "webp");
  assert(stripped);
  assert(!contains(bytes, "GPSDATA!"));
  assert(contains(bytes, "VP8 "));
  // RIFF size field equals (total length - 8).
  const riffSize = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) |
    (bytes[7]! << 24);
  assertEquals(riffSize, bytes.length - 8);
});

Deno.test("strip is a no-op (stripped=false) when there's no metadata", () => {
  // A clean PNG with only IHDR/IDAT/IEND.
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]) => {
    const len = data.length;
    const t = [...type].map((c) => c.charCodeAt(0));
    return [
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...t,
      ...data,
      0,
      0,
      0,
      0,
    ];
  };
  const clean = new Uint8Array([
    ...sig,
    ...chunk("IHDR", [0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]),
    ...chunk("IDAT", [1, 2, 3]),
    ...chunk("IEND", []),
  ]);
  const { stripped } = stripImageMetadata(clean, "png");
  assertEquals(stripped, false);
});

// HEIC must never be silently passed through: its ISOBMFF EXIF (incl. GPS) can't
// be stripped in pure TS, so stripImageMetadata throws rather than store live
// GPS. Every upload path rejects HEIC at validateImageUpload(); this guards the
// case where a future caller widens `allow` and forgets that invariant.
Deno.test("stripImageMetadata throws on HEIC instead of leaking GPS", () => {
  const heic = new Uint8Array(16);
  heic.set([...new TextEncoder().encode("\0\0\0ftypheic")], 0);
  assertThrows(
    () => stripImageMetadata(heic, "heic"),
    Error,
    "HEIC",
  );
});

// Belt-and-suspenders: the actual upload paths reject HEIC before strip is ever
// reached, so the throw above is unreachable in production today.
Deno.test("validateImageUpload rejects HEIC for the standard allowlist", () => {
  const heic = new Uint8Array(16);
  // ISOBMFF: bytes 4-7 = "ftyp", bytes 8-11 = brand "heic".
  heic.set([...new TextEncoder().encode("ftypheic")], 4);
  const r = validateImageUpload(heic, { allow: ["jpeg", "png", "webp"] });
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("not allowed"));
});
