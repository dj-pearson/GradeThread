// US-1763: video upload validation unit tests. Pure byte logic — hand-built
// container fixtures, no decoder.
import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_MAX_VIDEO_SECONDS,
  H264_SAMPLE_ENTRIES,
  HEVC_SAMPLE_ENTRIES,
  isoBmffVideoCodec,
  validateVideoUpload,
} from "../lib/video-validation.ts";

// ── ISO-BMFF (MP4/MOV) fixture builders ────────────────────────────

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function fourcc(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
function box(type: string, content: number[]): number[] {
  const size = 8 + content.length;
  return [...u32(size), ...fourcc(type), ...content];
}

// mvhd v0: version(1)+flags(3) + creation(4)+mod(4) + timescale(4) + duration(4)
// + the rest (rate/volume/matrix/…) which the parser skips.
function mvhdV0(timescale: number, duration: number): number[] {
  const rest = new Array(80).fill(0); // padding past duration, unread
  return [
    0x00,
    0x00,
    0x00,
    0x00, // version 0 + flags
    ...u32(0), // creation
    ...u32(0), // modification
    ...u32(timescale),
    ...u32(duration),
    ...rest,
  ];
}

function ftyp(brand: string): number[] {
  // brand(4) + minor_version(4) + one compatible brand(4)
  return box("ftyp", [...fourcc(brand), ...u32(0), ...fourcc("mp42")]);
}

function mp4(brand: string, timescale: number, duration: number): Uint8Array {
  const moov = box("moov", box("mvhd", mvhdV0(timescale, duration)));
  return new Uint8Array([...ftyp(brand), ...moov]);
}

// MP4 whose moov is absent from the head (streaming/faststart trailing moov).
function mp4NoMoov(brand: string): Uint8Array {
  const mdat = box("mdat", new Array(64).fill(0x11));
  return new Uint8Array([...ftyp(brand), ...mdat]);
}

// ── WebM / EBML fixture builders ───────────────────────────────────

const ID = {
  ebml: [0x1a, 0x45, 0xdf, 0xa3],
  segment: [0x18, 0x53, 0x80, 0x67],
  info: [0x15, 0x49, 0xa9, 0x66],
  duration: [0x44, 0x89],
  timecodeScale: [0x2a, 0xd7, 0xb1],
  docType: [0x42, 0x82],
};

// 1-byte EBML size vint (content length ≤ 127).
function sizeVint(len: number): number[] {
  if (len > 127) throw new Error("test helper only supports ≤127-byte sizes");
  return [0x80 | len];
}
function elem(id: number[], content: number[]): number[] {
  return [...id, ...sizeVint(content.length), ...content];
}
function f64(n: number): number[] {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, n);
  return [...new Uint8Array(dv.buffer)];
}
function uintBytes(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return out;
}

// WebM with Duration in TimecodeScale units. seconds = raw * scale / 1e9.
function webm(rawDuration: number, timecodeScale = 1_000_000): Uint8Array {
  const header = elem(ID.ebml, elem(ID.docType, fourcc("webm")));
  const info = elem(ID.info, [
    ...elem(ID.timecodeScale, uintBytes(timecodeScale)),
    ...elem(ID.duration, f64(rawDuration)),
  ]);
  const segment = elem(ID.segment, info);
  return new Uint8Array([...header, ...segment]);
}

// ── Sniffing / format acceptance ───────────────────────────────────

Deno.test("accepts a well-formed MP4 (isom)", () => {
  const r = validateVideoUpload(mp4("isom", 600, 3000)); // 5.0s
  assert(r.ok);
  assertEquals(r.format, "mp4");
  assertEquals(r.contentType, "video/mp4");
  assertEquals(r.ext, "mp4");
  assertEquals(r.durationSeconds, 5);
});

Deno.test("accepts a QuickTime MOV (qt brand)", () => {
  const r = validateVideoUpload(mp4("qt  ", 1000, 8000)); // 8.0s
  assert(r.ok);
  assertEquals(r.format, "mov");
  assertEquals(r.contentType, "video/quicktime");
});

Deno.test("accepts a ftyp-less MOV (leading moov atom)", () => {
  const moov = box("moov", box("mvhd", mvhdV0(1000, 4000)));
  const r = validateVideoUpload(new Uint8Array(moov));
  assert(r.ok);
  assertEquals(r.format, "mov");
  assertEquals(r.durationSeconds, 4);
});

Deno.test("accepts a well-formed WebM and parses duration", () => {
  const r = validateVideoUpload(webm(10_000)); // 10000 * 1e6 / 1e9 = 10s
  assert(r.ok);
  assertEquals(r.format, "webm");
  assertEquals(r.contentType, "video/webm");
  assertEquals(r.durationSeconds, 10);
});

// ── Duration cap ───────────────────────────────────────────────────

Deno.test("rejects an over-long MP4", () => {
  const r = validateVideoUpload(mp4("isom", 1000, 90_000)); // 90s
  assert(!r.ok);
  assert(r.reason.includes("too long"));
});

Deno.test("rejects an over-long WebM", () => {
  const r = validateVideoUpload(webm(120_000)); // 120s
  assert(!r.ok);
  assert(r.reason.includes("too long"));
});

Deno.test("honors a custom maxDurationSeconds", () => {
  const short = mp4("isom", 1000, 20_000); // 20s
  assert(validateVideoUpload(short).ok);
  const r = validateVideoUpload(short, { maxDurationSeconds: 10 });
  assert(!r.ok);
});

Deno.test("duration parsing is fail-open when moov is absent", () => {
  const r = validateVideoUpload(mp4NoMoov("isom"));
  assert(r.ok);
  assertEquals(r.durationSeconds, null); // byte cap remains the backstop
});

Deno.test("default max duration is 60s", () => {
  assertEquals(DEFAULT_MAX_VIDEO_SECONDS, 60);
  const r = validateVideoUpload(mp4("isom", 1000, 61_000));
  assert(!r.ok);
});

// ── Byte cap ───────────────────────────────────────────────────────

Deno.test("rejects oversized payloads", () => {
  const r = validateVideoUpload(mp4("isom", 600, 3000), { maxBytes: 32 });
  assert(!r.ok);
  assert(r.reason.includes("too large"));
});

Deno.test("rejects an empty file", () => {
  const r = validateVideoUpload(new Uint8Array(0));
  assert(!r.ok);
  assertEquals(r.reason, "Empty file");
});

// ── Rejections: images & non-video ─────────────────────────────────

Deno.test("rejects a HEIC/HEIF photo posing as video", () => {
  const r = validateVideoUpload(mp4("heic", 1000, 1000));
  assert(!r.ok);
  assert(r.reason.toLowerCase().includes("heic"));
});

Deno.test("rejects an AVIF still", () => {
  const r = validateVideoUpload(mp4("avif", 1000, 1000));
  assert(!r.ok);
});

Deno.test("rejects a JPEG", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
  const r = validateVideoUpload(jpeg);
  assert(!r.ok);
  assert(r.reason.includes("JPEG"));
});

Deno.test("rejects a PNG", () => {
  const png = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new Array(16).fill(0),
  ]);
  const r = validateVideoUpload(png);
  assert(!r.ok);
  assert(r.reason.includes("PNG"));
});

Deno.test("rejects a WebP image (not WebM)", () => {
  const webp = new Uint8Array([
    ...fourcc("RIFF"),
    ...u32(100),
    ...fourcc("WEBP"),
    ...new Array(8).fill(0),
  ]);
  const r = validateVideoUpload(webp);
  assert(!r.ok);
  assert(r.reason.includes("WebP"));
});

Deno.test("rejects AVI with a helpful message", () => {
  const avi = new Uint8Array([
    ...fourcc("RIFF"),
    ...u32(100),
    ...fourcc("AVI "),
    ...new Array(8).fill(0),
  ]);
  const r = validateVideoUpload(avi);
  assert(!r.ok);
  assert(r.reason.includes("AVI"));
});

Deno.test("rejects an executable", () => {
  const exe = new Uint8Array([0x4d, 0x5a, ...new Array(20).fill(0)]);
  const r = validateVideoUpload(exe);
  assert(!r.ok);
});

Deno.test("rejects unrecognized bytes", () => {
  const junk = new Uint8Array(new Array(32).fill(0x7a));
  const r = validateVideoUpload(junk);
  assert(!r.ok);
  assert(r.reason.includes("Unrecognized"));
});

// ── allow-list ─────────────────────────────────────────────────────

Deno.test("allow-list rejects a disallowed-but-valid format", () => {
  const r = validateVideoUpload(webm(5000), { allow: ["mp4", "mov"] });
  assert(!r.ok);
  assert(r.reason.includes("not allowed"));
});

// ── US-1980: the video codec, for the eBay Media API ───────────────
//
// eBay accepts H.264 only, and `.mp4` says nothing about what is inside. These
// build a real moov > trak > mdia > {hdlr, minf > stbl > stsd} tree, because a
// fixture that skipped a level would pass against a parser that skipped the
// same level.

/** hdlr: version+flags(4) + pre_defined(4) + handler_type(4) + the rest. */
function hdlr(handler: string): number[] {
  return box("hdlr", [
    ...u32(0),
    ...u32(0),
    ...fourcc(handler),
    ...new Array(12).fill(0), // reserved
    0x00, // empty name
  ]);
}

/** stsd: version+flags(4) + entry_count(4) + one sample entry box. */
function stsd(sampleEntry: string): number[] {
  return box("stsd", [
    ...u32(0),
    ...u32(1),
    ...box(sampleEntry, new Array(70).fill(0)),
  ]);
}

function trak(handler: string, sampleEntry: string): number[] {
  return box(
    "trak",
    box("mdia", [
      ...hdlr(handler),
      ...box("minf", box("stbl", stsd(sampleEntry))),
    ]),
  );
}

function mp4WithTracks(...tracks: number[][]): Uint8Array {
  const moov = box("moov", [
    ...box("mvhd", mvhdV0(600, 6000)),
    ...tracks.flat(),
  ]);
  return new Uint8Array([...ftyp("isom"), ...moov]);
}

Deno.test("US-1980: an H.264 track reports avc1", () => {
  assertEquals(
    isoBmffVideoCodec(mp4WithTracks(trak("vide", "avc1"))),
    "avc1",
  );
  assert(H264_SAMPLE_ENTRIES.has("avc1"));
  assert(H264_SAMPLE_ENTRIES.has("avc3"));
});

Deno.test("US-1980: an HEVC track is reported, not silently accepted", () => {
  // The iPhone default. Caught here or it becomes a PROCESSING_FAILED after a
  // 150 MB upload, indistinguishable from a corrupt file.
  const codec = isoBmffVideoCodec(mp4WithTracks(trak("vide", "hvc1")));
  assertEquals(codec, "hvc1");
  assert(HEVC_SAMPLE_ENTRIES.has(codec!));
  assert(!H264_SAMPLE_ENTRIES.has(codec!));
});

Deno.test("US-1980: an audio track before the video one is skipped", () => {
  // Plenty of muxers put sound first. Reading the first `trak` blindly reports
  // `mp4a` and calls a perfectly good H.264 file non-H.264.
  assertEquals(
    isoBmffVideoCodec(mp4WithTracks(trak("soun", "mp4a"), trak("vide", "avc1"))),
    "avc1",
  );
});

Deno.test("US-1980: an audio-only file has no video codec", () => {
  assertEquals(isoBmffVideoCodec(mp4WithTracks(trak("soun", "mp4a"))), null);
});

Deno.test("US-1980: a trailing moov reads as unknown, never as rejected", () => {
  // Fail-open, matching the duration parser. A caller holding only a prefix of
  // a faststart-less file genuinely cannot see the codec, and refusing on
  // unknown would block valid uploads.
  assertEquals(isoBmffVideoCodec(mp4NoMoov("isom")), null);
});

Deno.test("US-1980: a truncated box tree does not throw", () => {
  // Hostile input reaches this before anything else does.
  for (const cut of [12, 24, 40, 64]) {
    const full = mp4WithTracks(trak("vide", "avc1"));
    isoBmffVideoCodec(full.slice(0, cut));
  }
  isoBmffVideoCodec(new Uint8Array(0));
});

Deno.test("US-1980: allowCodecs refuses HEVC with the fix in the message", () => {
  const hevc = mp4WithTracks(trak("vide", "hvc1"));
  const verdict = validateVideoUpload(hevc, { allowCodecs: ["avc1", "avc3"] });
  assertEquals(verdict.ok, false);
  if (verdict.ok) return;
  assertEquals(verdict.codec, "hvc1");
  // The message has to be actionable. "Unsupported codec" sends the seller
  // nowhere; naming the Camera setting is the whole point of catching this
  // before the upload rather than after it.
  assert(/Most Compatible/.test(verdict.reason), verdict.reason);
  assert(/H\.264/.test(verdict.reason), verdict.reason);
});

Deno.test("US-1980: allowCodecs passes H.264 and is opt-in", () => {
  const h264 = mp4WithTracks(trak("vide", "avc1"));
  assert(validateVideoUpload(h264, { allowCodecs: ["avc1", "avc3"] }).ok);
  // Absent the option, the codec is reported and nothing is refused on it -
  // the existing US-1763 grading path must not start rejecting HEVC.
  const noOpt = validateVideoUpload(mp4WithTracks(trak("vide", "hvc1")), {});
  assertEquals(noOpt.ok, true);
  if (noOpt.ok) assertEquals(noOpt.codec, "hvc1");
});

Deno.test("US-1980: an unreadable codec is never refused", () => {
  // Fail-open. A faststart-less file hides moov behind mdat, and a caller
  // holding a prefix would otherwise have every valid upload refused.
  const verdict = validateVideoUpload(mp4NoMoov("isom"), {
    allowCodecs: ["avc1"],
  });
  assertEquals(verdict.ok, true);
  if (verdict.ok) assertEquals(verdict.codec, null);
});
