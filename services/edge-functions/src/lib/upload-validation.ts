// Server-side upload validation (US-276).
//
// Never trust the client-declared MIME or file extension. This sniffs the
// actual magic bytes, enforces an image allowlist (JPEG/PNG/WebP/HEIC),
// explicitly rejects SVG (script-bearing) and other non-image payloads, caps
// byte size, and parses + caps pixel dimensions where the format allows it
// cheaply (no decoder). Pure + deterministic → fully unit-testable.

export type ImageFormat = "jpeg" | "png" | "webp" | "heic";

export const IMAGE_CONTENT_TYPE: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
};

export const IMAGE_EXT: Record<ImageFormat, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  heic: "heic",
};

// Matches the storage bucket's 10 MB limit; callers may pass a smaller cap.
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
// A generous ceiling that still blocks decompression-bomb-sized dimensions.
export const DEFAULT_MAX_DIMENSION = 12_000;

export interface ValidateOptions {
  maxBytes?: number;
  maxDimension?: number;
  // US-529: reject images whose LONGEST side is below this when dimensions are
  // parseable (fail-open when they aren't — the byte caps still apply). Gates
  // unusably small uploads (eBay won't accept pictures under 500px long-side).
  minDimension?: number;
  // Restrict to a subset of formats (e.g. the private bucket allows no HEIC).
  allow?: ImageFormat[];
}

export type ValidationResult =
  | {
    ok: true;
    format: ImageFormat;
    contentType: string;
    ext: string;
    width: number | null;
    height: number | null;
  }
  | { ok: false; reason: string };

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i] ?? 0);
  return s;
}

// HEIC/HEIF ftyp brands we accept.
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "heif",
]);

// Identify the real format from magic bytes, or null if not a supported image.
export function sniffImageFormat(b: Uint8Array): ImageFormat | null {
  if (b.length < 12) return null;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return "png";
  // WebP: "RIFF"...."WEBP"
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  // HEIC/HEIF: ....ftyp<brand>
  if (ascii(b, 4, 4) === "ftyp" && HEIF_BRANDS.has(ascii(b, 8, 4))) {
    return "heic";
  }
  return null;
}

// True for payloads we must actively reject even though a lax check might pass
// (SVG can carry script; these are common "image" smuggling vectors).
function looksLikeRejectedType(b: Uint8Array): string | null {
  const head = ascii(b, 0, Math.min(b.length, 256)).trim().toLowerCase();
  if (
    head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg")
  ) {
    return "SVG images are not allowed";
  }
  if (head.startsWith("%pdf")) return "PDF uploads are not allowed";
  if (ascii(b, 0, 4) === "GIF8") return "GIF images are not allowed";
  if (b[0] === 0x4d && b[1] === 0x5a) {
    return "executable uploads are not allowed";
  }
  return null;
}

// PNG: width/height are big-endian u32 at IHDR offsets 16/20.
function pngDimensions(
  b: Uint8Array,
): { width: number; height: number } | null {
  if (b.length < 24) return null;
  const u32 = (o: number) =>
    ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  return { width: u32(16), height: u32(20) };
}

// JPEG: scan segments for a Start-Of-Frame (SOFn) marker and read its dims.
function jpegDimensions(
  b: Uint8Array,
): { width: number; height: number } | null {
  let off = 2; // skip SOI
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1]!;
    // Standalone markers without a length payload.
    if (
      marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)
    ) {
      off += 2;
      continue;
    }
    const len = (b[off + 2]! << 8) | b[off + 3]!;
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC) carry frame dimensions.
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      const height = (b[off + 5]! << 8) | b[off + 6]!;
      const width = (b[off + 7]! << 8) | b[off + 8]!;
      return { width, height };
    }
    if (marker === 0xda) break; // start of scan — no SOF found before image data
    off += 2 + len;
  }
  return null;
}

// WebP: read the canvas/frame size from the first chunk after the RIFF
// header. Covers all three container layouts: VP8X (extended), "VP8 " (lossy),
// VP8L (lossless) — canvas.toBlob("image/webp") emits lossy VP8 or VP8X.
function webpDimensions(
  b: Uint8Array,
): { width: number; height: number } | null {
  if (b.length < 20) return null;
  const fourcc = ascii(b, 12, 4);
  const d = 20; // chunk data starts after fourcc(4) + size(4)
  if (fourcc === "VP8X" && b.length >= d + 10) {
    // flags(1) + reserved(3), then 24-bit little-endian width-1 / height-1.
    const width = 1 + (b[d + 4]! | (b[d + 5]! << 8) | (b[d + 6]! << 16));
    const height = 1 + (b[d + 7]! | (b[d + 8]! << 8) | (b[d + 9]! << 16));
    return { width, height };
  }
  if (fourcc === "VP8 " && b.length >= d + 10) {
    // Key-frame: 3-byte frame tag, sync code 9D 01 2A, then 14-bit dims.
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) {
      return null;
    }
    const width = (b[d + 6]! | (b[d + 7]! << 8)) & 0x3fff;
    const height = (b[d + 8]! | (b[d + 9]! << 8)) & 0x3fff;
    return { width, height };
  }
  if (fourcc === "VP8L" && b.length >= d + 5) {
    if (b[d] !== 0x2f) return null; // VP8L signature byte
    const bits = (b[d + 1]! | (b[d + 2]! << 8) | (b[d + 3]! << 16) |
      (b[d + 4]! << 24)) >>> 0;
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

function dimensionsFor(
  format: ImageFormat,
  b: Uint8Array,
): { width: number; height: number } | null {
  if (format === "png") return pngDimensions(b);
  if (format === "jpeg") return jpegDimensions(b);
  if (format === "webp") return webpDimensions(b);
  // HEIC dimension parsing is format-heavy; the byte-size cap still
  // applies and we don't block on unknown dimensions.
  return null;
}

/**
 * US-1896: cheap width/height read for an already-trusted image byte payload
 * (e.g. a photo WE just generated: remove.bg output, a rendered overlay). No
 * validation — just sniff the format and parse the header dimensions. Returns
 * null when the format is unknown/HEIC or the header can't be parsed, so callers
 * persist width/height only when they're actually known (the picture-standards
 * preflight fails open on null dimensions).
 */
export function readImageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const format = sniffImageFormat(bytes);
  if (!format) return null;
  return dimensionsFor(format, bytes);
}

export function validateImageUpload(
  bytes: Uint8Array,
  opts: ValidateOptions = {},
): ValidationResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDim = opts.maxDimension ?? DEFAULT_MAX_DIMENSION;

  if (bytes.length === 0) return { ok: false, reason: "Empty file" };
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      reason: `File too large (${bytes.length} bytes; max ${maxBytes})`,
    };
  }

  const rejected = looksLikeRejectedType(bytes);
  if (rejected) return { ok: false, reason: rejected };

  const format = sniffImageFormat(bytes);
  if (!format) {
    return { ok: false, reason: "Unrecognized or unsupported image format" };
  }
  if (opts.allow && !opts.allow.includes(format)) {
    return { ok: false, reason: `${format} uploads are not allowed here` };
  }

  const dims = dimensionsFor(format, bytes);
  if (dims) {
    if (dims.width <= 0 || dims.height <= 0) {
      return { ok: false, reason: "Invalid image dimensions" };
    }
    if (dims.width > maxDim || dims.height > maxDim) {
      return {
        ok: false,
        reason:
          `Image too large (${dims.width}x${dims.height}; max ${maxDim}px/side)`,
      };
    }
    if (
      opts.minDimension !== undefined &&
      Math.max(dims.width, dims.height) < opts.minDimension
    ) {
      return {
        ok: false,
        reason:
          `Image too small (${dims.width}x${dims.height}; the longest side must be at least ${opts.minDimension}px)`,
      };
    }
  }

  return {
    ok: true,
    format,
    contentType: IMAGE_CONTENT_TYPE[format],
    ext: IMAGE_EXT[format],
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  };
}

// ── Receipts (US-2228 AC2) ───────────────────────────────────────────────────
//
// An expense receipt is the one upload in the product that is legitimately a
// PDF: half of what a seller gets emailed is a PDF invoice, and telling them to
// screenshot it to attach it would be the app making its own problem theirs.
//
// This is a SEPARATE function rather than a flag on validateImageUpload, and
// that is deliberate. validateImageUpload actively REJECTS a PDF by magic bytes
// (looksLikeRejectedType), because everywhere else a PDF arriving where an image
// was expected is an attack shape. Loosening it would have relaxed that rule for
// garment photos, listing imagery and dispute evidence too, to serve one screen.
//
// ⚠ THE HONEST LIMITATION, stated because it is easy to assume otherwise: an
// image receipt goes through stripImageMetadata like every other image, so EXIF
// and GPS are gone. A PDF DOES NOT — its metadata (author, producer, sometimes a
// local file path) is left intact, because stripping it needs a PDF parser we do
// not have and will not hand-roll. That is acceptable HERE and nowhere else: the
// object lands in a private bucket with no policies, is read only through a
// signed URL issued after an ownership check, is never published, never attached
// to a certificate and never sent to a model. A PDF must not be accepted into
// any surface without those four properties.

export type ReceiptKind = "image" | "pdf";

export type ReceiptValidationResult =
  | {
    ok: true;
    kind: ReceiptKind;
    contentType: string;
    ext: string;
    /** Present for images only — PDFs are stored byte-for-byte. */
    format: ImageFormat | null;
  }
  | { ok: false; reason: string };

/** %PDF- at offset 0. The version digits after it vary and are not checked. */
export function looksLikePdf(b: Uint8Array): boolean {
  return b.length >= 5 && ascii(b, 0, 5) === "%PDF-";
}

export function validateReceiptUpload(
  bytes: Uint8Array,
  opts: ValidateOptions = {},
): ReceiptValidationResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  if (bytes.length === 0) return { ok: false, reason: "Empty file" };
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      reason: `File too large (${bytes.length} bytes; max ${maxBytes})`,
    };
  }

  // PDF first: validateImageUpload would reject it, and its rejection message
  // ("PDF uploads are not allowed") would be actively wrong on this screen.
  if (looksLikePdf(bytes)) {
    return {
      ok: true,
      kind: "pdf",
      contentType: "application/pdf",
      ext: "pdf",
      format: null,
    };
  }

  // No HEIC: the bucket's allowed_mime_types does not list it, so an accepted
  // HEIC would fail at the storage layer with an error nobody can act on.
  const image = validateImageUpload(bytes, {
    ...opts,
    allow: opts.allow ?? ["jpeg", "png", "webp"],
  });
  if (!image.ok) return image;

  return {
    ok: true,
    kind: "image",
    contentType: image.contentType,
    ext: image.ext,
    format: image.format,
  };
}
