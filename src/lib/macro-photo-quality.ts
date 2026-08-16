// US-2136: the web port of the iOS tag-quality gate, generalized to every
// macro slot.
//
// iOS has had this since TagPhotoQuality.swift: a 700px long-edge floor plus
// on-device OCR requiring at least 4 recognized characters before a tag photo
// is accepted. Web had NO quality gate at all, so a blurry or too-distant macro
// shot reached the model looking exactly like a good one — and the seller only
// found out when the brand came back wrong, or the authenticity pass returned
// low confidence for reasons nobody could see.
//
// ── What is ported, and the one thing that is NOT ────────────────────────
//
// The resolution floor ports directly. The OCR check does not: the browser has
// no built-in text recognizer, and the alternative (bundling Tesseract's ~2MB
// wasm) is a real cost on every page load to replicate a check whose PURPOSE is
// "is there enough detail here to read". A sharpness measure answers that
// question directly rather than by proxy, is a few hundred bytes, and catches
// the failures OCR was standing in for — blur, camera shake, glare, too far.
//
// So the web gate is: long-edge floor (per slot) + sharpness floor (per slot).
// Both are measured; see measureMacroPhoto() for the browser half.
//
// ── Deliberately LENIENT, in both directions ─────────────────────────────
//
// Same posture as iOS: Claude Vision reads a marginal photo better than any
// client-side check, so the gate WARNS and offers a retake — it never blocks an
// upload. A false "retake this" on a photo the model would have read fine
// trains sellers to ignore the nudge, which is worse than the occasional blurry
// tag. Unknown inputs (a dimension we could not read, a decode failure) are
// treated as fine, exactly like the iOS `guard let ... else { return .ok }`.

import { RETIRED_PHOTO_TYPES, roleLabel } from "./photo-roles";

/** Slots that carry fine detail the model must actually resolve. */
export type MacroQualityReason = "low_resolution" | "unsharp";

/**
 * US-2471: every lookup below is keyed on the (type, role) PAIR, not on a
 * numbered slot.
 *
 * Before roles, the maps had to name `tag_2`, `detail_2`, `detail_3` and
 * `detail_4` one at a time and give each the same number as its base type. That
 * is the enumeration the photo-tags epic retired: a new sub-role now ships as a
 * line in photo-roles.ts, and a map that lists slots by number would silently
 * NOT cover it — a `detail:hem` shot would fall off the map and get no floor at
 * all, which is the failure mode this rewrite removes.
 *
 * A retired type still arriving from an older cached bundle is collapsed onto
 * its base pair first, so it resolves to exactly the number it always did.
 */
// This module serves BOTH uploaders, and they speak different vocabularies:
// the FlipDesk one (`tag`, `tag_2`) and the grading submission one (`label`,
// `label_2`). RETIRED_PHOTO_TYPES covers only the first, so the grading
// spellings need their own line — `label_2` is the same retired second-tag slot
// as `tag_2` and must collapse the same way. Missing this is what the
// both-spellings test above the gate exists to catch (US-2136 AC2).
const RETIRED_GRADING_IMAGE_TYPES: Record<
  string,
  { type: string; role: string | null }
> = {
  label_2: { type: "label", role: null },
  detail_2: { type: "detail", role: null },
  detail_3: { type: "detail", role: null },
  detail_4: { type: "detail", role: null },
};

function baseSlot(
  photoType: string | null | undefined,
  photoRole?: string | null,
): { type: string; role: string | null } | null {
  if (!photoType) return null;
  const retired = RETIRED_PHOTO_TYPES[photoType] ??
    RETIRED_GRADING_IMAGE_TYPES[photoType];
  if (retired) return { type: retired.type, role: retired.role };
  return { type: photoType, role: photoRole ?? null };
}

/** `"detail:fabric"`, or `"detail"` when the slot carries no qualifier. */
function slotKey(type: string, role: string | null): string {
  return role ? `${type}:${role}` : type;
}

export interface MacroQualityAssessment {
  /** False only when we are confident the photo is too poor to read. */
  ok: boolean;
  reason: MacroQualityReason | null;
  /** Actionable in-capture guidance. Null when ok. */
  message: string | null;
  /**
   * 0..1 continuous quality, or null when it could not be measured.
   *
   * Kept even when `ok` is true, because US-2136 AC4 wants authenticity
   * confidence to read a MEASURE rather than a pass/fail bit — an accepted-but-
   * marginal macro should not carry the same weight as a crisp one.
   */
  score: number | null;
}

/**
 * Long-edge floors, in pixels, per macro slot.
 *
 * 700 is the iOS floor, set for the brand/care tag: the smallest frame in which
 * printed care text stays legible after JPEG. The slots that need MORE than a
 * tag are the ones where the evidence is a stamp, a code or a stitch — those
 * are read at a smaller physical scale than tag text, so they need more pixels
 * across the same subject.
 *
 * Slots absent from this map are not macro shots (front, back, flatlay,
 * on_model, measurement frames) and are governed by photo-standards.ts instead,
 * which enforces the marketplace's own 500px floor. Two gates, two purposes:
 * that one is "will eBay accept it", this one is "can the model read it".
 */
export const MACRO_MIN_LONG_EDGE_PX: Readonly<Record<string, number>> = {
  // Tag / care label — the iOS baseline, and the highest-traffic macro slot.
  tag: 700,
  // The web submission flow spells the same slot `label`.
  label: 700,
  // Fabric close-ups feed the fabric_condition factor, which is 30% of the
  // grade — the weave has to be resolvable, not merely present.
  detail: 700,
  // A defect close-up is the evidence for a deduction. If it is unreadable the
  // grader is guessing at severity.
  defect: 700,
  // Authenticity evidence (US-2136 AC2). Serials, date codes and maker's marks
  // are struck at a smaller scale than tag print, so they need more resolution
  // to survive the same amount of compression.
  serial: 900,
  marking: 900,
  // Construction evidence — stitch density, sole moulding, corner wear.
  surface: 800,
  corner: 800,
  sole: 800,
  interior: 700,
  certificate: 700,
};

/**
 * Sharpness floors per slot, on the 0..1 scale measureMacroPhoto() returns.
 *
 * Lower than instinct suggests, on purpose. This is a "was the shot obviously
 * botched" line, not a quality bar — a slightly soft photo of a legible tag is
 * still a photo the model reads. Only the authenticity slots sit higher,
 * because a soft photo of a serial is worthless rather than merely worse.
 */
export const MACRO_MIN_SHARPNESS: Readonly<Record<string, number>> = {
  serial: 0.35,
  marking: 0.35,
  surface: 0.3,
  corner: 0.3,
  sole: 0.3,
};

/**
 * Per-ROLE overrides, keyed `"type:role"`, layered over the per-type maps above.
 *
 * DELIBERATELY EMPTY. US-2471 moves the floors off numbered slots; it does not
 * re-tune them, and every role today inherits the number its old numbered slot
 * had. Raising `detail:fabric` because fabric_condition is 30% of the grade is a
 * defensible idea and an accuracy change — it belongs behind an eval, not inside
 * a refactor whose whole claim is that nothing moved.
 *
 * This is the extension point: a role that genuinely needs more pixels than its
 * type's baseline gets one line here and no other edit.
 */
export const MACRO_MIN_LONG_EDGE_BY_ROLE: Readonly<Record<string, number>> = {};
export const MACRO_MIN_SHARPNESS_BY_ROLE: Readonly<Record<string, number>> = {};

/** The floor applied to any macro slot without its own entry above. */
export const DEFAULT_MIN_SHARPNESS = 0.22;

// ── US-2135: scoped upload resolution ───────────────────────────────────
//
// Web compresses every capture to a 2400px WIDTH cap. For a macro shot that is
// the binding constraint on evidence: a label filling a third of the frame
// arrives as roughly 500px of label — enough to OCR a size, nowhere near enough
// for stitch density, kerning or engraving fidelity.
//
// STATE PLAINLY WHAT THIS DOES AND DOES NOT BUY. Claude normalizes an image's
// long edge to ~1568px, so shipping more pixels does NOT change what the model
// sees today. What it changes is what we RETAINED: the crop-and-zoom pipeline
// that would actually deliver a magnified tag region (US-2135 AC2, generalizing
// the Forensic defect zoom) cannot recover detail that was thrown away at
// capture. This is AC1's "retain a higher-resolution original", and it is
// worthless-looking until AC2 lands — which is exactly why it has to land
// first.
//
// AC5 forbids raising this globally, and it is right to: the iOS cap was
// LOWERED to 1600px deliberately for upload speed, and that tradeoff is real on
// mobile data. So the increase is scoped to the macro slots, and sized against
// the 10MB byte ceiling both the client and DEFAULT_MAX_BYTES enforce — a
// 3600px WebP at q0.85 lands around 1-3MB, comfortably inside it, whereas the
// ~4700px a third-frame crop would need to reach Claude's ceiling does not.
export const DEFAULT_UPLOAD_MAX_WIDTH_PX = 2400;

export const MACRO_UPLOAD_MAX_WIDTH_PX: Readonly<Record<string, number>> = {
  // Authenticity evidence. The tell IS the fine detail — a struck serial, a
  // maker's mark, stitch pitch, moulding seams — so these get the most.
  serial: 3600,
  marking: 3600,
  surface: 3600,
  corner: 3600,
  sole: 3600,
  // Tag and close-up slots: legibility of printed text and weave. Real gain
  // over 2400 without the byte cost of the authenticity tier on the slots
  // sellers shoot most often.
  // US-2632: the MeasureCard frame. It is not a macro shot — the card sits
  // BESIDE a whole garment — and it had the lowest cap of any slot, which is
  // backwards for the one photo whose entire job is metrology.
  //
  // The card's fiducials are 1in squares and the detector needs ~40px across
  // each one. A pair of pants laid flat fills ~50in of frame, so at the 2400px
  // default the squares land at ~48px BEFORE any server-side downscale — right
  // on the edge, and over it for anything larger or shot with more margin.
  // That is what produced "move the camera closer" on a photo that could not be
  // shot any closer without cropping the garment being measured.
  //
  // 3600 is the authenticity tier, chosen for the same reason it was chosen
  // there: it lands around 1-3MB at q0.85, comfortably inside the 10MB ceiling.
  measurement: 3600,
  tag: 3000,
  label: 3000,
  detail: 3000,
  defect: 3000,
  interior: 3000,
  certificate: 3000,
};

/**
 * Width cap to compress this slot's upload to. Returns the unchanged global
 * default for every non-macro slot, so a caller can pass the result
 * unconditionally without deciding whether the slot is special.
 */
export function uploadMaxWidthFor(
  photoType: string | null | undefined,
  photoRole?: string | null,
): number {
  const slot = baseSlot(photoType, photoRole);
  if (!slot) return DEFAULT_UPLOAD_MAX_WIDTH_PX;
  return MACRO_UPLOAD_MAX_WIDTH_PX[slot.type] ?? DEFAULT_UPLOAD_MAX_WIDTH_PX;
}

/** True when this photo slot is a macro shot the gate applies to. */
export function isMacroPhotoType(
  photoType: string | null | undefined,
  photoRole?: string | null,
): boolean {
  const slot = baseSlot(photoType, photoRole);
  return !!slot && slot.type in MACRO_MIN_LONG_EDGE_PX;
}

/** The long-edge floor for a slot, or null when the slot is not a macro shot. */
export function minLongEdgeFor(
  photoType: string | null | undefined,
  photoRole?: string | null,
): number | null {
  const slot = baseSlot(photoType, photoRole);
  if (!slot) return null;
  const byType = MACRO_MIN_LONG_EDGE_PX[slot.type];
  if (byType == null) return null;
  return MACRO_MIN_LONG_EDGE_BY_ROLE[slotKey(slot.type, slot.role)] ?? byType;
}

/** The sharpness floor for a slot, or null when the slot is not a macro shot. */
export function minSharpnessFor(
  photoType: string | null | undefined,
  photoRole?: string | null,
): number | null {
  const slot = baseSlot(photoType, photoRole);
  if (!slot || !(slot.type in MACRO_MIN_LONG_EDGE_PX)) return null;
  const key = slotKey(slot.type, slot.role);
  return MACRO_MIN_SHARPNESS_BY_ROLE[key] ??
    MACRO_MIN_SHARPNESS[slot.type] ??
    DEFAULT_MIN_SHARPNESS;
}

/**
 * Friendly slot noun for the guidance copy ("fabric close-up", "tag", …).
 *
 * The role is what makes this specific. "Move closer and fill the frame with
 * the close-up" was always a slightly absurd sentence; with a role it becomes
 * "fill the frame with the fabric close-up", which names the thing the seller
 * is pointing the camera at.
 */
function slotNoun(photoType: string, photoRole: string | null): string {
  const labelled = roleLabel(photoType, photoRole);
  if (labelled) return labelled.toLowerCase();
  if (photoType.startsWith("tag") || photoType.startsWith("label")) return "tag";
  if (photoType.startsWith("detail")) return "close-up";
  if (photoType === "defect") return "flaw";
  if (photoType === "serial") return "serial or date code";
  if (photoType === "marking") return "maker's mark";
  if (photoType === "certificate") return "certificate";
  return photoType.replace(/_/g, " ");
}

/**
 * In-capture guidance (US-2136 AC3). Says what to DO, not what is wrong — a
 * seller who is told "low resolution" learns nothing they can act on, and the
 * two failures have genuinely different remedies: get closer vs hold still.
 */
export function macroQualityMessage(
  reason: MacroQualityReason,
  photoType: string,
  photoRole?: string | null,
): string {
  const slot = baseSlot(photoType, photoRole);
  const noun = slot ? slotNoun(slot.type, slot.role) : photoType;
  return reason === "low_resolution"
    ? `Move closer and fill the frame with the ${noun} — this shot is too small for AI to read reliably.`
    : `This ${noun} looks blurry. Hold steady, tap to focus, and retake it in good light.`;
}

export interface MacroPhotoMeasurement {
  photoType: string | null | undefined;
  /** US-2471: the `item_photos.photo_role` qualifier, when the slot has one. */
  photoRole?: string | null;
  /** Longest side in pixels, or null when it could not be read. */
  longEdge: number | null;
  /** 0..1 sharpness from measureMacroPhoto(), or null when not measured. */
  sharpness: number | null;
}

/**
 * Assess one captured macro photo. Pure — the browser measurement lives in
 * measureMacroPhoto() so this half is testable without a canvas.
 *
 * FAILS OPEN in every uncertain case: a non-macro slot, an unknown dimension,
 * an unmeasured sharpness. A gate that blocks on its own inability to measure
 * blames the user for our problem.
 */
export function assessMacroPhoto(m: MacroPhotoMeasurement): MacroQualityAssessment {
  const floor = minLongEdgeFor(m.photoType, m.photoRole);
  if (floor == null) return { ok: true, reason: null, message: null, score: null };
  const photoType = m.photoType as string;
  const photoRole = m.photoRole ?? null;

  // Resolution is checked first and reported alone: a too-small photo is also
  // usually a soft one, and "move closer" is the action that fixes both.
  if (m.longEdge != null && Number.isFinite(m.longEdge) && m.longEdge < floor) {
    return {
      ok: false,
      reason: "low_resolution",
      message: macroQualityMessage("low_resolution", photoType, photoRole),
      score: m.sharpness,
    };
  }

  const sharpFloor = minSharpnessFor(photoType, photoRole);
  if (
    m.sharpness != null &&
    Number.isFinite(m.sharpness) &&
    sharpFloor != null &&
    m.sharpness < sharpFloor
  ) {
    return {
      ok: false,
      reason: "unsharp",
      message: macroQualityMessage("unsharp", photoType, photoRole),
      score: m.sharpness,
    };
  }

  return { ok: true, reason: null, message: null, score: m.sharpness };
}

// ── The browser half ────────────────────────────────────────────────────
//
// Sharpness = normalized variance of the Laplacian, the standard blur metric.
// A sharp image has strong local intensity changes (high second-derivative
// variance); a blurred one has those smoothed away.
//
// Measured on a downscaled grayscale copy, which matters for two reasons: it
// bounds the cost to a fixed ~65k pixels regardless of a 48MP phone capture,
// and it makes the number comparable ACROSS photos — variance computed at
// native resolution would rank a 4000px photo above a 1000px photo of the same
// subject purely because it has more edges to sum.

/** Long edge of the downscaled buffer the Laplacian runs on. */
const SHARPNESS_SAMPLE_LONG_EDGE = 256;

/**
 * Variance is unbounded; this divisor maps the useful range onto 0..1. Chosen
 * so a well-lit in-focus macro lands comfortably above the floors above and a
 * visibly blurred one lands below. Exported so the tests state the mapping
 * rather than hard-coding magic numbers in their expectations.
 */
export const SHARPNESS_VARIANCE_SCALE = 1500;

/** Normalize a raw Laplacian variance onto 0..1. Pure, so it is testable. */
export function normalizeSharpness(variance: number): number {
  if (!Number.isFinite(variance) || variance <= 0) return 0;
  return Math.min(1, variance / SHARPNESS_VARIANCE_SCALE);
}

/**
 * Laplacian variance over a grayscale buffer. Pure over plain arrays so the
 * math is unit-testable without a DOM.
 *
 * Skips the 1px border rather than clamping at the edges: a clamped edge
 * produces an artificial zero-response ring that drags the variance down more
 * on small buffers than large ones, which would make the score depend on the
 * sample size we deliberately fixed.
 */
export function laplacianVariance(
  gray: ArrayLike<number>,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v =
        4 * (gray[i] as number) -
        (gray[i - 1] as number) -
        (gray[i + 1] as number) -
        (gray[i - width] as number) -
        (gray[i + width] as number);
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Measure a captured image in the browser: long edge at NATIVE resolution, and
 * sharpness off a downscaled grayscale copy.
 *
 * Never throws — a decode or canvas failure returns nulls, which assessMacroPhoto
 * reads as "cannot tell" and passes.
 */
export async function measureMacroPhoto(
  source: Blob | HTMLImageElement,
  photoType: string | null | undefined,
  photoRole?: string | null,
): Promise<MacroPhotoMeasurement> {
  const unmeasured: MacroPhotoMeasurement = {
    photoType,
    photoRole,
    longEdge: null,
    sharpness: null,
  };
  // Only pay for the decode on slots the gate actually applies to.
  if (!isMacroPhotoType(photoType, photoRole)) return unmeasured;

  try {
    const bitmap =
      source instanceof Blob
        ? await createImageBitmap(source)
        : source;
    const srcW = "width" in bitmap ? bitmap.width : 0;
    const srcH = "height" in bitmap ? bitmap.height : 0;
    if (!srcW || !srcH) return unmeasured;

    const longEdge = Math.max(srcW, srcH);
    const scale = Math.min(1, SHARPNESS_SAMPLE_LONG_EDGE / longEdge);
    const w = Math.max(3, Math.round(srcW * scale));
    const h = Math.max(3, Math.round(srcH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { photoType, photoRole, longEdge, sharpness: null };
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      // Rec. 601 luma — the channel weighting human contrast perception uses,
      // and what every reference implementation of this metric assumes.
      gray[p] =
        0.299 * (data[i] as number) +
        0.587 * (data[i + 1] as number) +
        0.114 * (data[i + 2] as number);
    }

    if (source instanceof Blob && "close" in bitmap) {
      (bitmap as ImageBitmap).close();
    }
    return {
      photoType,
      photoRole,
      longEdge,
      sharpness: normalizeSharpness(laplacianVariance(gray, w, h)),
    };
  } catch {
    // Decode/canvas failures are ours, not the seller's — fail open.
    return unmeasured;
  }
}
