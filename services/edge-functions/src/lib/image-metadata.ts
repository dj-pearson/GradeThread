// EXIF / GPS metadata stripping before storage (US-276).
//
// Phone photos embed GPS coordinates and device info in EXIF (JPEG APP1), PNG
// text/eXIf chunks, and WebP EXIF/XMP chunks. We strip those carriers in pure
// TS (no image decoder) so a stored/served photo can't leak where or on what
// device it was taken. The pixel data is preserved byte-for-byte — only
// metadata segments are dropped. Unknown/HEIC formats pass through unchanged
// (the private grading bucket doesn't accept HEIC; flipdesk transcodes it).
import type { ImageFormat } from "./upload-validation.ts";

export interface StripResult {
  bytes: Uint8Array;
  stripped: boolean;
}

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[start + i] ?? 0);
  return s;
}

// JPEG: copy SOI, keep only JFIF(APP0)/ICC(APP2)/Adobe(APP14) app segments and
// all non-app segments, drop EXIF/XMP(APP1) and IPTC/Photoshop(APP13); then
// append the entropy-coded image data from SOS onward unchanged.
function stripJpeg(b: Uint8Array): StripResult {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    return { bytes: b, stripped: false };
  }
  const out: number[] = [0xff, 0xd8];
  let off = 2;
  let dropped = false;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) break; // malformed — bail out safely
    const marker = b[off + 1]!;
    if (marker === 0xda) {
      // Start of scan: copy the rest verbatim (compressed data → EOI).
      for (let i = off; i < b.length; i++) out.push(b[i]!);
      off = b.length;
      break;
    }
    if (marker === 0xd9) {
      out.push(0xff, 0xd9);
      off += 2;
      break;
    }
    const len = (b[off + 2]! << 8) | b[off + 3]!;
    const segEnd = off + 2 + len;
    if (len < 2 || segEnd > b.length) break; // malformed — stop here
    const isApp = marker >= 0xe0 && marker <= 0xef;
    // Keep APP0 (JFIF), APP2 (ICC color), APP14 (Adobe); drop the rest of APPn.
    const keep = !isApp || marker === 0xe0 || marker === 0xe2 ||
      marker === 0xee;
    if (keep) {
      for (let i = off; i < segEnd; i++) out.push(b[i]!);
    } else {
      dropped = true;
    }
    off = segEnd;
  }
  if (!dropped) return { bytes: b, stripped: false };
  return { bytes: new Uint8Array(out), stripped: true };
}

const PNG_DROP_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

// PNG: walk the chunk list, drop metadata chunks, keep the rest byte-for-byte.
function stripPng(b: Uint8Array): StripResult {
  if (b.length < 8) return { bytes: b, stripped: false };
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(b[i]!); // signature
  let off = 8;
  let dropped = false;
  while (off + 8 <= b.length) {
    const len = ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) |
      b[off + 3]!) >>>
      0;
    const type = ascii(b, off + 4, 4);
    const chunkEnd = off + 12 + len; // len + type(4) + data + crc(4)
    if (chunkEnd > b.length) break; // malformed
    if (PNG_DROP_CHUNKS.has(type)) {
      dropped = true;
    } else {
      for (let i = off; i < chunkEnd; i++) out.push(b[i]!);
    }
    off = chunkEnd;
    if (type === "IEND") break;
  }
  if (!dropped) return { bytes: b, stripped: false };
  return { bytes: new Uint8Array(out), stripped: true };
}

// WebP (RIFF): drop EXIF/XMP chunks, rewrite the RIFF size, and clear the
// EXIF/XMP presence flags in a VP8X header if present.
function stripWebp(b: Uint8Array): StripResult {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") {
    return { bytes: b, stripped: false };
  }
  const kept: number[] = [];
  for (let i = 8; i < 12; i++) kept.push(b[i]!); // "WEBP"
  let off = 12;
  let dropped = false;
  while (off + 8 <= b.length) {
    const fourcc = ascii(b, off, 4);
    const size = ((b[off + 4]!) | (b[off + 5]! << 8) | (b[off + 6]! << 16) |
      (b[off + 7]! << 24)) >>> 0;
    const padded = size + (size % 2); // chunks are padded to even length
    const chunkEnd = off + 8 + padded;
    if (chunkEnd > b.length) break;
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      dropped = true;
    } else {
      for (let i = off; i < chunkEnd; i++) {
        let byte = b[i]!;
        // VP8X flags byte sits at chunk-data offset 0 (off+8): clear EXIF(bit3)
        // and XMP(bit2) so a decoder doesn't look for now-removed chunks.
        if (fourcc === "VP8X" && i === off + 8) byte &= ~0b00001100;
        kept.push(byte);
      }
    }
    off = chunkEnd;
  }
  if (!dropped) return { bytes: b, stripped: false };
  const riffSize = kept.length;
  const out = new Uint8Array(8 + kept.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;
  out.set(kept, 8);
  return { bytes: out, stripped: true };
}

// Strip metadata for a known format. Falls back to passthrough for HEIC/unknown.
export function stripImageMetadata(
  bytes: Uint8Array,
  format: ImageFormat,
): StripResult {
  switch (format) {
    case "jpeg":
      return stripJpeg(bytes);
    case "png":
      return stripPng(bytes);
    case "webp":
      return stripWebp(bytes);
    default:
      return { bytes, stripped: false };
  }
}
