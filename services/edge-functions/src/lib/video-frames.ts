// Walk-around video → grading frames (US-1764, part of the US-1762 epic).
//
// A seller records ONE short clip walking around the garment instead of staging
// individual photos. This module turns that clip into a small set of still
// frames mapped onto the SAME image-type slots the photo path uses
// (front/back/label/detail…), so `processSubmission` and the whole per-image →
// composite grading flow run completely unchanged: the frames are written as
// ordinary `submission_images` rows and nothing downstream knows the difference.
//
// SHAPE — the expensive/impure part is one thin function:
//   * PURE (this file, unit-tested): which timestamps to sample, how to score a
//     candidate frame (sharpness / exposure), how to de-duplicate near-identical
//     frames, which slot each frame fills, and the hard frame cap.
//   * IMPURE (`extractVideoFrames`): shells out to ffmpeg for the actual decode.
//
// COST — frames are Vision calls. The grading pipeline issues ONE Claude Vision
// call per image, and a video submission is billed as ONE grade, so an uncapped
// frame count is a direct AI-cost multiplier. Every path here is bounded by
// `clampFrameCount` and near-duplicate frames are DROPPED rather than graded:
// a second photo of the same view costs a full Vision call and adds no coverage.
//
// FAILURE — extraction is best-effort and never fabricates. If ffmpeg is absent,
// times out, or the clip yields no usable frame for a REQUIRED slot, the caller
// falls the submission back to `needs_photos` (the same abstention the image
// quality gate uses) rather than grading a garment it could not actually see.

import { Image } from "imagescript";
import { dHashFromRgba } from "./perceptual-hash.ts";
// The capture_source marker + the frame floor live in verified-capture.ts,
// which owns provenance and has no imports of its own (so nothing here can
// create a cycle). Re-exported for callers that only deal in frames.
export { VIDEO_FRAME_CAPTURE_SOURCE } from "./verified-capture.ts";

// Slot fill order. The first four are REQUIRED for a gradeable submission and
// deliberately match REQUIRED_IMAGE_TYPES + the one-detail rule enforced on the
// photo path, so a video submission clears exactly the same coverage bar.
export const VIDEO_FRAME_SLOT_ORDER = [
  "front",
  "back",
  "label",
  "detail",
  "detail_2",
  "detail_3",
  "detail_4",
  "defect",
] as const;

export type VideoFrameSlot = (typeof VIDEO_FRAME_SLOT_ORDER)[number];

// A frame must exist for each of these or the clip is not gradeable.
export const REQUIRED_VIDEO_FRAME_SLOTS: readonly VideoFrameSlot[] = [
  "front",
  "back",
  "label",
  "detail",
];

// Frame-count bounds. MIN is the required-slot count (below it the submission
// cannot clear the coverage bar at all); HARD_MAX is the ceiling no operator
// setting may exceed, because each frame is another paid Vision call.
export const MIN_VIDEO_FRAMES = REQUIRED_VIDEO_FRAME_SLOTS.length;
export const DEFAULT_MAX_VIDEO_FRAMES = 6;
export const HARD_MAX_VIDEO_FRAMES = VIDEO_FRAME_SLOT_ORDER.length;

// How many candidate stills we sample around each planned timestamp before
// picking the sharpest. Decoding a still is cheap (no AI); grading a blurry one
// is not, so a small burst buys real quality for no Vision cost.
export const CANDIDATES_PER_SLOT = 3;
// Seconds between the candidates in a burst.
const CANDIDATE_SPACING_SECONDS = 0.3;
// Absolute ceiling on ffmpeg invocations for one clip — the backstop if a plan
// and a burst size ever multiply out further than intended.
export const MAX_FRAME_EXTRACTIONS = HARD_MAX_VIDEO_FRAMES * CANDIDATES_PER_SLOT;

// dHash Hamming distance below which two frames are "the same view". A
// walk-around naturally passes through similar angles; grading both costs two
// Vision calls for one piece of evidence.
export const DUPLICATE_HAMMING_DISTANCE = 6;

// Exposure gate on the 0..255 mean luma. Outside this band the frame is a
// black/blown-out transition, not a view of the garment.
const MIN_MEAN_LUMA = 28;
const MAX_MEAN_LUMA = 240;
// Laplacian-variance floor below which a frame is motion-blurred beyond use.
// Deliberately permissive: the vision pass's own quality gate (image-quality.ts)
// is the authoritative blur judge; this only rejects the obviously unusable.
const MIN_SHARPNESS = 12;

/**
 * Clamp an operator-configured frame cap into the safe band.
 *
 * ABSENT config (null/undefined/"") means "not configured" and takes the
 * DEFAULT, not the minimum — `Number(null)` is 0, which would otherwise clamp a
 * missing setting down to the bare four required views and quietly cost every
 * video grade its optional coverage.
 */
export function clampFrameCount(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") {
    return DEFAULT_MAX_VIDEO_FRAMES;
  }
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_MAX_VIDEO_FRAMES;
  return Math.min(HARD_MAX_VIDEO_FRAMES, Math.max(MIN_VIDEO_FRAMES, n));
}

/** One planned sample point: the slot to fill and where to look for it. */
export interface FramePlanEntry {
  slot: VideoFrameSlot;
  /** The timestamp this slot is centred on (seconds into the clip). */
  atSeconds: number;
  /** The burst actually decoded, best-of wins. Always includes `atSeconds`. */
  candidateSeconds: number[];
}

/**
 * Seller-tapped "I'm showing the front now" marks from the guided capture UI.
 * Optional: an unguided clip still grades, it just samples evenly.
 */
export type VideoSlotMarks = Partial<Record<VideoFrameSlot, number>>;

function isSlot(v: string): v is VideoFrameSlot {
  return (VIDEO_FRAME_SLOT_ORDER as readonly string[]).includes(v);
}

/**
 * Parse + bound the client-supplied slot marks. NEVER trusted: unknown slot
 * names, non-finite values, and timestamps outside the clip are dropped, so a
 * forged blob can at worst make the sampling WORSE (an evenly-spaced fallback),
 * never make ffmpeg seek somewhere it shouldn't.
 */
export function parseVideoSlotMarks(
  raw: unknown,
  durationSeconds: number | null,
): VideoSlotMarks {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const limit = durationSeconds && durationSeconds > 0 ? durationSeconds : null;
  const out: VideoSlotMarks = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (!isSlot(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) continue;
    if (limit !== null && n > limit) continue;
    out[key] = n;
  }
  return out;
}

/**
 * Decide which timestamps to sample and which slot each fills.
 *
 * With guided marks, each marked slot is sampled where the seller said that view
 * is. Without them (or for slots the seller never marked) the clip is sampled at
 * evenly-spaced points — a walk-around passes through every side, so even
 * sampling is a reasonable prior and the selection step below still rejects the
 * unusable ones.
 *
 * Pure + deterministic: same duration + marks always yields the same plan, which
 * is what makes the cost of a video submission predictable.
 */
export function planVideoFrames(opts: {
  durationSeconds: number;
  marks?: VideoSlotMarks;
  maxFrames?: number;
  candidatesPerSlot?: number;
}): FramePlanEntry[] {
  const duration = Number.isFinite(opts.durationSeconds) && opts.durationSeconds > 0
    ? opts.durationSeconds
    : 0;
  if (duration <= 0) return [];

  const maxFrames = clampFrameCount(opts.maxFrames ?? DEFAULT_MAX_VIDEO_FRAMES);
  const burst = Math.max(
    1,
    Math.min(CANDIDATES_PER_SLOT, Math.floor(opts.candidatesPerSlot ?? CANDIDATES_PER_SLOT)),
  );
  const marks = opts.marks ?? {};

  // Stay a hair inside the clip: seeking to exactly 0 or exactly the end is the
  // reliable way to land on a black transition frame.
  const edge = Math.min(0.2, duration / 20);
  const lo = edge;
  const hi = Math.max(lo, duration - edge);
  const clamp = (t: number) => Math.min(hi, Math.max(lo, t));

  const slots = VIDEO_FRAME_SLOT_ORDER.slice(0, maxFrames);
  const plan: FramePlanEntry[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const marked = marks[slot];
    const atSeconds = clamp(
      marked !== undefined ? marked : (duration * (i + 0.5)) / slots.length,
    );
    const candidates = new Set<number>([Number(atSeconds.toFixed(3))]);
    for (let k = 1; candidates.size < burst; k++) {
      candidates.add(Number(clamp(atSeconds - k * CANDIDATE_SPACING_SECONDS).toFixed(3)));
      if (candidates.size >= burst) break;
      candidates.add(Number(clamp(atSeconds + k * CANDIDATE_SPACING_SECONDS).toFixed(3)));
      // A very short clip can't produce distinct candidates; stop rather than spin.
      if (k > burst + 2) break;
    }
    plan.push({
      slot,
      atSeconds,
      candidateSeconds: [...candidates].sort((a, b) => a - b),
    });
  }
  return plan;
}

/** Total ffmpeg invocations a plan implies — bounded by MAX_FRAME_EXTRACTIONS. */
export function planExtractionCount(plan: FramePlanEntry[]): number {
  return plan.reduce((n, e) => n + e.candidateSeconds.length, 0);
}

// ── Frame quality signals (pure) ─────────────────────────────────────────────

/**
 * Mean luma (Rec.601) of an RGBA buffer, 0..255. The exposure signal: a frame
 * that is nearly black or blown out shows nothing gradeable.
 */
export function meanLuma(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): number {
  const n = width * height;
  if (n <= 0 || rgba.length < n * 4) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sum += 0.299 * (rgba[o] ?? 0) + 0.587 * (rgba[o + 1] ?? 0) +
      0.114 * (rgba[o + 2] ?? 0);
  }
  return sum / n;
}

/**
 * Variance of the 4-neighbour Laplacian over a luma plane — the standard
 * reference-free sharpness proxy. A motion-blurred frame from a walk-around has
 * a markedly lower value than a held one, which is the whole reason we sample a
 * burst per slot and keep the best.
 *
 * Pure over an explicit luma plane so it is testable without a decoder.
 */
export function laplacianVariance(
  luma: Uint8Array | Float64Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3 || luma.length < width * height) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = 4 * (luma[i] ?? 0) -
        (luma[i - 1] ?? 0) - (luma[i + 1] ?? 0) -
        (luma[i - width] ?? 0) - (luma[i + width] ?? 0);
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Row-major luma plane from an RGBA buffer (Rec.601), for laplacianVariance. */
export function lumaPlane(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(Math.max(0, width * height));
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = Math.round(
      0.299 * (rgba[o] ?? 0) + 0.587 * (rgba[o + 1] ?? 0) + 0.114 * (rgba[o + 2] ?? 0),
    );
  }
  return out;
}

/** Hamming distance between two 16-hex dHashes; null when either is unusable. */
export function hammingHex(a: string | null, b: string | null): number | null {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16);
    const y = parseInt(b[i]!, 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    let v = x ^ y;
    while (v) {
      d += v & 1;
      v >>= 1;
    }
  }
  return d;
}

// ── Selection (pure) ─────────────────────────────────────────────────────────

/** A decoded candidate still, ready to be scored against its slot-mates. */
export interface FrameCandidate {
  slot: VideoFrameSlot;
  atSeconds: number;
  bytes: Uint8Array;
  /** Laplacian variance — higher is sharper. */
  sharpness: number;
  /** Mean luma 0..255. */
  luma: number;
  /** 16-hex dHash, or null when the frame couldn't be hashed. */
  phash: string | null;
}

export interface SelectedFrame {
  slot: VideoFrameSlot;
  atSeconds: number;
  bytes: Uint8Array;
  sharpness: number;
  luma: number;
  phash: string | null;
}

export interface FrameSelection {
  /** True only when every REQUIRED slot was filled. */
  ok: boolean;
  frames: SelectedFrame[];
  /** Why a planned slot produced no frame — kept for the server-side record. */
  dropped: Array<{ slot: VideoFrameSlot; reason: string }>;
  /** Human-readable summary for the submission's extraction record. */
  reason: string;
}

function usable(c: FrameCandidate): boolean {
  return c.bytes.length > 0 &&
    c.luma >= MIN_MEAN_LUMA && c.luma <= MAX_MEAN_LUMA &&
    c.sharpness >= MIN_SHARPNESS;
}

/**
 * Pick one frame per planned slot: the sharpest well-exposed candidate that is
 * not a near-duplicate of a frame already chosen.
 *
 * De-duplication is a COST control as much as a quality one. A near-identical
 * frame is another full Vision call for evidence we already have, so an
 * OPTIONAL slot whose best candidate duplicates an earlier one is dropped
 * outright. A REQUIRED slot is never dropped for duplication — front and back of
 * a plain black tee legitimately look alike, and refusing to grade that would be
 * wrong — it only fails when nothing usable exists at all.
 */
export function selectVideoFrames(
  plan: FramePlanEntry[],
  candidates: FrameCandidate[],
): FrameSelection {
  const chosen: SelectedFrame[] = [];
  const dropped: Array<{ slot: VideoFrameSlot; reason: string }> = [];

  for (const entry of plan) {
    const required = REQUIRED_VIDEO_FRAME_SLOTS.includes(entry.slot);
    const forSlot = candidates
      .filter((c) => c.slot === entry.slot)
      .sort((a, b) => b.sharpness - a.sharpness);

    if (forSlot.length === 0) {
      dropped.push({ slot: entry.slot, reason: "no frame decoded" });
      continue;
    }
    const good = forSlot.filter(usable);
    if (good.length === 0) {
      dropped.push({
        slot: entry.slot,
        reason: "every candidate was too dark, blown out, or motion-blurred",
      });
      continue;
    }

    const isDuplicate = (c: FrameCandidate) =>
      chosen.some((s) => {
        const d = hammingHex(c.phash, s.phash);
        return d !== null && d < DUPLICATE_HAMMING_DISTANCE;
      });

    const distinct = good.find((c) => !isDuplicate(c));
    const pick = distinct ?? (required ? good[0]! : null);
    if (!pick) {
      dropped.push({
        slot: entry.slot,
        reason: "duplicate of a frame already selected",
      });
      continue;
    }
    chosen.push({
      slot: entry.slot,
      atSeconds: pick.atSeconds,
      bytes: pick.bytes,
      sharpness: pick.sharpness,
      luma: pick.luma,
      phash: pick.phash,
    });
  }

  const filled = new Set(chosen.map((f) => f.slot));
  const missing = REQUIRED_VIDEO_FRAME_SLOTS.filter((s) => !filled.has(s));
  if (missing.length > 0) {
    return {
      ok: false,
      frames: chosen,
      dropped,
      reason:
        `The clip did not yield a usable ${missing.join(", ")} view — record a slower walk-around in brighter, even light.`,
    };
  }
  return {
    ok: true,
    frames: chosen,
    dropped,
    reason: `${chosen.length} frame(s) selected from the clip${
      dropped.length ? `; ${dropped.length} slot(s) skipped` : ""
    }.`,
  };
}

// ── Extraction (impure — ffmpeg) ─────────────────────────────────────────────

/** ffmpeg binary. Overridable so a deploy can point at a bundled static build. */
function ffmpegPath(): string {
  return Deno.env.get("FFMPEG_PATH")?.trim() || "ffmpeg";
}

/** Longest side (px) the extracted stills are scaled to before grading. */
function frameMaxDimension(): number {
  const raw = Number(Deno.env.get("VIDEO_FRAME_MAX_DIMENSION"));
  return Number.isFinite(raw) && raw >= 640 && raw <= 2048 ? Math.floor(raw) : 1280;
}

const FFMPEG_TIMEOUT_MS = 15_000;

let ffmpegProbe: Promise<boolean> | null = null;

/**
 * Is a usable ffmpeg on this host? Probed once and cached.
 *
 * Deliberately tolerant of a PermissionDenied: the edge container only gets
 * --allow-run when video grading is deployed, so an older/leaner deploy simply
 * reports "unavailable" and every video submission falls back to needs_photos
 * instead of crashing the route.
 */
export function ffmpegAvailable(): Promise<boolean> {
  if (!ffmpegProbe) {
    ffmpegProbe = (async () => {
      try {
        const out = await new Deno.Command(ffmpegPath(), {
          args: ["-version"],
          stdout: "piped",
          stderr: "null",
        }).output();
        return out.success;
      } catch {
        return false;
      }
    })();
  }
  return ffmpegProbe;
}

/** Test seam: forget the cached probe result. */
export function resetFfmpegProbeForTest(): void {
  ffmpegProbe = null;
}

/**
 * Decode ONE still at `atSeconds`. `-ss` before `-i` is the fast (keyframe) seek,
 * which is what keeps a burst of candidates cheap; `image2pipe` avoids needing
 * write access for the output.
 */
async function decodeStill(
  videoPath: string,
  atSeconds: number,
): Promise<Uint8Array | null> {
  const dim = frameMaxDimension();
  const cmd = new Deno.Command(ffmpegPath(), {
    args: [
      "-nostdin",
      "-loglevel",
      "error",
      "-ss",
      atSeconds.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      // Scale the LONGEST side down to `dim`, never up, keeping even dimensions
      // (mjpeg requires them) and the aspect ratio.
      "-vf",
      `scale='if(gt(iw,ih),min(${dim},iw),-2)':'if(gt(iw,ih),-2,min(${dim},ih))'`,
      "-q:v",
      "3",
      "-f",
      "image2",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ],
    stdout: "piped",
    stderr: "null",
  });
  const child = cmd.spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, FFMPEG_TIMEOUT_MS);
  try {
    const out = await child.output();
    if (!out.success || out.stdout.length === 0) return null;
    return out.stdout;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Score a decoded still. Returns null when it can't be decoded at all. */
async function scoreStill(
  bytes: Uint8Array,
): Promise<{ sharpness: number; luma: number; phash: string | null } | null> {
  try {
    const img = await Image.decode(bytes);
    const { bitmap, width, height } = img;
    const luma = meanLuma(bitmap, width, height);
    const plane = lumaPlane(bitmap, width, height);
    const sharpness = laplacianVariance(plane, width, height);
    return { sharpness, luma, phash: dHashFromRgba(bitmap, width, height) };
  } catch {
    return null;
  }
}

export type ExtractVideoFramesResult =
  | { ok: true; selection: FrameSelection; plan: FramePlanEntry[]; extracted: number }
  | { ok: false; reason: string; plan: FramePlanEntry[]; extracted: number };

/**
 * Turn clip bytes into the selected grading frames.
 *
 * Writes the clip to a temp file first because `-ss` fast-seek needs a SEEKABLE
 * input — a piped MP4 whose `moov` atom trails the media (what a phone writes)
 * cannot be seeked at all. The file is always removed, including on failure.
 */
export async function extractVideoFrames(opts: {
  videoBytes: Uint8Array;
  durationSeconds: number;
  marks?: VideoSlotMarks;
  maxFrames?: number;
  ext?: string;
}): Promise<ExtractVideoFramesResult> {
  const plan = planVideoFrames({
    durationSeconds: opts.durationSeconds,
    marks: opts.marks,
    maxFrames: opts.maxFrames,
  });
  if (plan.length === 0) {
    return {
      ok: false,
      reason: "The clip's duration could not be read, so no frames could be planned.",
      plan,
      extracted: 0,
    };
  }
  if (planExtractionCount(plan) > MAX_FRAME_EXTRACTIONS) {
    return {
      ok: false,
      reason: "Frame plan exceeded the extraction cap.",
      plan,
      extracted: 0,
    };
  }
  if (!(await ffmpegAvailable())) {
    return {
      ok: false,
      reason: "Video frame extraction is not available on this deployment.",
      plan,
      extracted: 0,
    };
  }

  let tmpPath: string | null = null;
  let extracted = 0;
  try {
    tmpPath = await Deno.makeTempFile({
      prefix: "gt-video-",
      suffix: `.${opts.ext ?? "mp4"}`,
    });
    await Deno.writeFile(tmpPath, opts.videoBytes);

    const candidates: FrameCandidate[] = [];
    for (const entry of plan) {
      for (const at of entry.candidateSeconds) {
        const bytes = await decodeStill(tmpPath, at);
        if (!bytes) continue;
        extracted++;
        const score = await scoreStill(bytes);
        if (!score) continue;
        candidates.push({
          slot: entry.slot,
          atSeconds: at,
          bytes,
          sharpness: score.sharpness,
          luma: score.luma,
          phash: score.phash,
        });
      }
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        reason: "No frame could be decoded from the clip.",
        plan,
        extracted,
      };
    }
    return { ok: true, selection: selectVideoFrames(plan, candidates), plan, extracted };
  } catch (err) {
    return {
      ok: false,
      reason: `Frame extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      plan,
      extracted,
    };
  } finally {
    if (tmpPath) {
      try {
        await Deno.remove(tmpPath);
      } catch {
        // Best effort — a leftover temp file must not fail a submission.
      }
    }
  }
}
