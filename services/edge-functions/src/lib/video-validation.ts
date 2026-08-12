// Server-side VIDEO upload validation (US-1763).
//
// Mirrors the image hardening in upload-validation.ts (US-276) for the
// walk-around-video grading path (US-1762 epic): never trust the client MIME
// or extension. This sniffs real magic bytes, enforces an allowlist
// (MP4 / QuickTime-MOV / WebM), explicitly rejects HEIF *image* containers and
// other non-video payloads, caps byte size, and — best-effort — parses the
// container duration to enforce a max-duration cap.
//
// Pure + deterministic (no decoder, no I/O) → fully unit-testable. Duration
// parsing is fail-OPEN: when the duration atom isn't in the supplied bytes
// (e.g. an MP4 with a trailing `moov`), it returns null and the byte-size cap
// remains the hard backstop — the same philosophy as HEIC dimension parsing.

export type VideoFormat = "mp4" | "mov" | "webm";

export const VIDEO_CONTENT_TYPE: Record<VideoFormat, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export const VIDEO_EXT: Record<VideoFormat, string> = {
  mp4: "mp4",
  mov: "mov",
  webm: "webm",
};

// A short walk-around clip, not a movie. Callers may pass a smaller cap.
export const DEFAULT_MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_MAX_VIDEO_SECONDS = 60;

export interface ValidateVideoOptions {
  maxBytes?: number;
  // Reject clips longer than this when the duration is parseable (fail-open
  // when it isn't — the byte cap still applies).
  maxDurationSeconds?: number;
  // Restrict to a subset of formats.
  allow?: VideoFormat[];
  /**
   * US-1980: restrict the video CODEC, not just the container. An .mp4 says
   * nothing about what is inside it, and eBay's Media API takes H.264 only.
   * Fail-open: an unreadable codec is allowed through, because a
   * faststart-less file legitimately hides moov behind mdat.
   */
  allowCodecs?: string[];
}

export type VideoValidationResult =
  | {
    ok: true;
    format: VideoFormat;
    contentType: string;
    ext: string;
    durationSeconds: number | null;
    /** US-1980: the video sample-entry fourcc, null when unreadable. */
    codec: string | null;
  }
  | { ok: false; reason: string; codec?: string | null };

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i] ?? 0);
  return s;
}

// HEIF *image* ftyp brands. These share the ISO-BMFF container with MP4 but are
// still-photo / motion-photo payloads, NOT video — a common thing to hand a
// "video" endpoint (an iPhone .heic or Live Photo still). Reject with a clear
// message so the client can convert or pick a real video (AC: HEVC/HEIC edge).
const HEIF_IMAGE_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "heif",
  "avif",
  "avis",
]);

// Top-level ISO-BMFF atom types that legitimately begin a (usually older,
// ftyp-less) QuickTime .mov file.
const MOV_LEADING_ATOMS = new Set([
  "moov",
  "mdat",
  "free",
  "skip",
  "wide",
  "pnot",
]);

// Non-video payloads worth an explicit, friendly rejection (they're common
// "video" mistakes or smuggling vectors).
function looksLikeRejectedType(b: Uint8Array): string | null {
  // Images (the private grading bucket already accepts these on the image path).
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "That's a JPEG image, not a video";
  }
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  ) return "That's a PNG image, not a video";
  if (ascii(b, 0, 4) === "GIF8") return "GIF is not an accepted video format";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    return "That's a WebP image, not a video";
  }
  // AVI (RIFF....AVI ) — not supported; ask for MP4/MOV/WebM.
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "AVI ") {
    return "AVI is not supported; upload MP4, MOV, or WebM";
  }
  const head = ascii(b, 0, Math.min(b.length, 64)).trim().toLowerCase();
  if (head.startsWith("<?xml") || head.includes("<svg")) {
    return "SVG is not a video";
  }
  if (head.startsWith("%pdf")) return "PDF uploads are not allowed";
  if (b[0] === 0x4d && b[1] === 0x5a) {
    return "executable uploads are not allowed";
  }
  return null;
}

// Identify the real video format from magic bytes, or return an error reason
// (for the HEIF-image case) or null (unrecognized).
function sniffVideoFormat(
  b: Uint8Array,
): { format: VideoFormat } | { reject: string } | null {
  if (b.length < 12) return null;
  // WebM / Matroska: EBML header 1A 45 DF A3.
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // Confirm the DocType is webm/matroska if it's within the head; otherwise
    // accept the EBML container (fail-open — the duration/byte caps still gate).
    const head = ascii(b, 0, Math.min(b.length, 256)).toLowerCase();
    if (head.includes("webm") || head.includes("matroska")) {
      return { format: "webm" };
    }
    return { format: "webm" };
  }
  // ISO base media (MP4 / MOV): "ftyp" at offset 4, brand at offset 8.
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4).trim();
    const brandRaw = ascii(b, 8, 4);
    if (HEIF_IMAGE_BRANDS.has(brandRaw) || HEIF_IMAGE_BRANDS.has(brand)) {
      return {
        reject:
          "That looks like a HEIC/HEIF photo (or Live Photo still), not a video — convert it to MP4 or upload a real video clip",
      };
    }
    if (brandRaw === "qt  " || brand === "qt") return { format: "mov" };
    // Everything else in the ISO-BMFF family (isom, iso2/4/5/6, mp41, mp42,
    // avc1, dash, M4V , M4A , cmfc, …) is treated as MP4.
    return { format: "mp4" };
  }
  // ftyp-less QuickTime .mov: a known leading atom at offset 4.
  if (MOV_LEADING_ATOMS.has(ascii(b, 4, 4))) return { format: "mov" };
  return null;
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>>
    0;
}
function u64be(b: Uint8Array, o: number): number {
  // JS-safe for the magnitudes we see (durations/timescales), loses precision
  // only well beyond any real clip.
  return u32be(b, o) * 2 ** 32 + u32be(b, o + 4);
}

// ISO-BMFF: walk top-level boxes to find `moov`, then its child `mvhd`, and
// return duration in seconds. Returns null if not present in the given bytes.
function isoBmffDurationSeconds(b: Uint8Array): number | null {
  const moov = findBox(b, 0, b.length, "moov");
  if (!moov) return null;
  const mvhd = findBox(b, moov.contentStart, moov.contentEnd, "mvhd");
  if (!mvhd) return null;
  const p = mvhd.contentStart;
  if (p + 1 > b.length) return null;
  const version = b[p]!;
  try {
    if (version === 1) {
      // version(1)+flags(3) + creation(8) + modification(8) + timescale(4) + duration(8)
      const timescale = u32be(b, p + 4 + 8 + 8);
      const duration = u64be(b, p + 4 + 8 + 8 + 4);
      if (timescale > 0) return duration / timescale;
    } else {
      // version 0: creation(4) + modification(4) + timescale(4) + duration(4)
      const timescale = u32be(b, p + 4 + 4 + 4);
      const duration = u32be(b, p + 4 + 4 + 4 + 4);
      if (timescale > 0) return duration / timescale;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The video codec fourcc of the first video track in an ISO-BMFF file, or null
 * when it cannot be read from the supplied bytes.
 *
 * US-1980: eBay's Media API accepts **H.264 only**, and an `.mp4` container
 * says nothing about what is inside it. iPhones have recorded HEVC by default
 * since iOS 11 unless the owner changed Camera > Formats to Most Compatible, so
 * the single most likely real-world upload is a container we accept holding a
 * codec eBay does not. Without this the rejection lands at the far end, as a
 * `PROCESSING_FAILED` **after** a 150 MB upload — and that status is
 * indistinguishable from a corrupt file, so the seller could not even be told
 * what went wrong.
 *
 * Walks `moov > trak > mdia > minf > stbl > stsd` and reads the first sample
 * entry's type. `avc1` / `avc3` are H.264; `hvc1` / `hev1` are HEVC.
 *
 * FAIL-OPEN, like `isoBmffDurationSeconds` above and for the same reason: a
 * streaming-optimised file can put `moov` after `mdat`, so a caller holding
 * only a prefix legitimately cannot see it. Null means "unknown", never
 * "rejected" - refusing on unknown would block valid uploads whose header the
 * caller did not read far enough to include.
 *
 * Returns the FIRST video track. A file with several is not something a seller
 * produces from a phone, and eBay takes one video per listing anyway.
 */
export function isoBmffVideoCodec(b: Uint8Array): string | null {
  const moov = findBox(b, 0, b.length, "moov");
  if (!moov) return null;
  // `trak` repeats: audio tracks come first in plenty of muxers, so scanning
  // only the first one would read `mp4a` and report the file as non-H.264.
  let off = moov.contentStart;
  let guard = 0;
  while (off + 8 <= moov.contentEnd && guard++ < 64) {
    const trak = findBox(b, off, moov.contentEnd, "trak");
    if (!trak) return null;
    const codec = codecOfTrack(b, trak);
    if (codec) return codec;
    off = trak.contentEnd;
  }
  return null;
}

/** The sample-entry fourcc of a `trak`, when that track is a VIDEO track. */
function codecOfTrack(
  b: Uint8Array,
  trak: { contentStart: number; contentEnd: number },
): string | null {
  const mdia = findBox(b, trak.contentStart, trak.contentEnd, "mdia");
  if (!mdia) return null;
  // `hdlr` says what kind of track this is. Checking it is what stops an audio
  // track's `mp4a` being reported as the video codec.
  const hdlr = findBox(b, mdia.contentStart, mdia.contentEnd, "hdlr");
  if (!hdlr) return null;
  // version(1)+flags(3) + pre_defined(4) + handler_type(4)
  const handler = ascii(b, hdlr.contentStart + 8, 4);
  if (handler !== "vide") return null;

  const minf = findBox(b, mdia.contentStart, mdia.contentEnd, "minf");
  if (!minf) return null;
  const stbl = findBox(b, minf.contentStart, minf.contentEnd, "stbl");
  if (!stbl) return null;
  const stsd = findBox(b, stbl.contentStart, stbl.contentEnd, "stsd");
  if (!stsd) return null;
  // version(1)+flags(3) + entry_count(4), then the first sample entry, which is
  // itself a box: size(4) + type(4).
  const first = stsd.contentStart + 8;
  if (first + 8 > b.length || first + 8 > stsd.contentEnd) return null;
  const fourcc = ascii(b, first + 4, 4);
  return fourcc.trim() === "" ? null : fourcc;
}

/** H.264 sample-entry types. `avc3` differs only in parameter-set placement. */
export const H264_SAMPLE_ENTRIES = new Set(["avc1", "avc3"]);

/** HEVC sample-entry types, named so the refusal can say what it found. */
export const HEVC_SAMPLE_ENTRIES = new Set(["hvc1", "hev1"]);

// Find a direct child box of the given type within [start,end). Returns its
// content span, or null. Defensive against truncated/degenerate sizes.
function findBox(
  b: Uint8Array,
  start: number,
  end: number,
  type: string,
): { contentStart: number; contentEnd: number } | null {
  let off = start;
  while (off + 8 <= end && off + 8 <= b.length) {
    let size = u32be(b, off);
    const boxType = ascii(b, off + 4, 4);
    let headerLen = 8;
    if (size === 1) {
      // 64-bit largesize follows the type.
      if (off + 16 > b.length) return null;
      size = u64be(b, off + 8);
      headerLen = 16;
    } else if (size === 0) {
      // Extends to end of file.
      size = end - off;
    }
    if (size < headerLen) return null; // degenerate — bail
    const contentStart = off + headerLen;
    const contentEnd = Math.min(off + size, end);
    if (boxType === type) return { contentStart, contentEnd };
    off += size;
  }
  return null;
}

// --- EBML / WebM duration ------------------------------------------------
// Read a variable-length integer at offset. `keepMarker` true for element IDs
// (the id is matched with its length-descriptor bits intact); false for sizes
// (strip the marker to get the numeric value). Returns [value, bytesRead].
function readVint(
  b: Uint8Array,
  off: number,
  keepMarker: boolean,
): [number, number] | null {
  if (off >= b.length) return null;
  const first = b[off]!;
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (first & mask) === 0) {
    len++;
    mask >>= 1;
  }
  if (len > 8 || off + len > b.length) return null;
  let value = keepMarker ? first : (first & (mask - 1));
  for (let i = 1; i < len; i++) value = value * 256 + b[off + i]!;
  return [value, len];
}

const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549a966;
const EBML_DURATION = 0x4489;
const EBML_TIMECODESCALE = 0x2ad7b1;

function readFloat(b: Uint8Array, off: number, len: number): number | null {
  if (off + len > b.length) return null;
  const view = new DataView(b.buffer, b.byteOffset + off, len);
  if (len === 4) return view.getFloat32(0);
  if (len === 8) return view.getFloat64(0);
  return null;
}
function readUint(b: Uint8Array, off: number, len: number): number | null {
  if (len < 1 || len > 8 || off + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[off + i]!;
  return v;
}

// Scan EBML master-element children within [start,end) for a target id via a
// callback. Stops when the callback returns a value (non-undefined).
function ebmlScan<T>(
  b: Uint8Array,
  start: number,
  end: number,
  visit: (id: number, dataStart: number, dataLen: number) => T | undefined,
): T | undefined {
  let off = start;
  while (off < end) {
    const idR = readVint(b, off, true);
    if (!idR) return undefined;
    const [id, idLen] = idR;
    const sizeR = readVint(b, off + idLen, false);
    if (!sizeR) return undefined;
    const [size, sizeLen] = sizeR;
    const dataStart = off + idLen + sizeLen;
    const dataLen = size;
    const hit = visit(id, dataStart, dataLen);
    if (hit !== undefined) return hit;
    if (dataStart + dataLen > b.length) return undefined;
    off = dataStart + dataLen;
  }
  return undefined;
}

function webmDurationSeconds(b: Uint8Array): number | null {
  // Top level → find Segment.
  const seg = ebmlScan(b, 0, b.length, (id, ds, dl) =>
    id === EBML_SEGMENT ? { ds, dl } : undefined);
  if (!seg) return null;
  const segEnd = Math.min(seg.ds + seg.dl, b.length);
  // Segment → find Info.
  const info = ebmlScan(b, seg.ds, segEnd, (id, ds, dl) =>
    id === EBML_INFO ? { ds, dl } : undefined);
  if (!info) return null;
  const infoEnd = Math.min(info.ds + info.dl, b.length);
  let timecodeScale = 1_000_000; // EBML default: nanoseconds per tick.
  let rawDuration: number | null = null;
  ebmlScan(b, info.ds, infoEnd, (id, ds, dl) => {
    if (id === EBML_TIMECODESCALE) {
      const v = readUint(b, ds, dl);
      if (v && v > 0) timecodeScale = v;
    } else if (id === EBML_DURATION) {
      rawDuration = readFloat(b, ds, dl);
    }
    return undefined; // visit all children of Info
  });
  if (rawDuration === null || !(rawDuration > 0)) return null;
  return (rawDuration * timecodeScale) / 1_000_000_000;
}

function durationSecondsFor(
  format: VideoFormat,
  b: Uint8Array,
): number | null {
  try {
    if (format === "webm") return webmDurationSeconds(b);
    return isoBmffDurationSeconds(b);
  } catch {
    return null;
  }
}

export function validateVideoUpload(
  bytes: Uint8Array,
  opts: ValidateVideoOptions = {},
): VideoValidationResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_VIDEO_BYTES;
  const maxDuration = opts.maxDurationSeconds ?? DEFAULT_MAX_VIDEO_SECONDS;

  if (bytes.length === 0) return { ok: false, reason: "Empty file" };
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      reason: `Video too large (${bytes.length} bytes; max ${maxBytes})`,
    };
  }

  const rejected = looksLikeRejectedType(bytes);
  if (rejected) return { ok: false, reason: rejected };

  const sniff = sniffVideoFormat(bytes);
  if (!sniff) {
    return { ok: false, reason: "Unrecognized or unsupported video format" };
  }
  if ("reject" in sniff) return { ok: false, reason: sniff.reject };
  const format = sniff.format;

  if (opts.allow && !opts.allow.includes(format)) {
    return { ok: false, reason: `${format} uploads are not allowed here` };
  }

  const durationSeconds = durationSecondsFor(format, bytes);
  if (durationSeconds !== null) {
    if (!(durationSeconds > 0)) {
      return { ok: false, reason: "Invalid video duration" };
    }
    if (durationSeconds > maxDuration) {
      return {
        ok: false,
        reason:
          `Video too long (${durationSeconds.toFixed(1)}s; max ${maxDuration}s)`,
      };
    }
  }

  // US-1980: an optional codec allowlist, for callers whose downstream is
  // pickier than the container. eBay's Media API takes H.264 only. Fail-open
  // when the codec cannot be read - see isoBmffVideoCodec for why - so this
  // narrows what is REFUSED and never what is required to be readable.
  const videoCodec = format === "webm" ? null : isoBmffVideoCodec(bytes);
  if (opts.allowCodecs && videoCodec && !opts.allowCodecs.includes(videoCodec)) {
    return {
      ok: false,
      reason: HEVC_SAMPLE_ENTRIES.has(videoCodec)
        ? "This video is HEVC (H.265). Re-record with Camera > Formats > Most " +
          "Compatible, or export it as H.264, and try again."
        : `Unsupported video codec '${videoCodec}'`,
      codec: videoCodec,
    };
  }

  return {
    ok: true,
    format,
    contentType: VIDEO_CONTENT_TYPE[format],
    ext: VIDEO_EXT[format],
    durationSeconds,
    codec: videoCodec,
  };
}
