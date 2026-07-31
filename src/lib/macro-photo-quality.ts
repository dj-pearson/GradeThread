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

/** Slots that carry fine detail the model must actually resolve. */
export type MacroQualityReason = "low_resolution" | "unsharp";

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
  tag_2: 700,
  // The web submission flow spells the same slot `label`.
  label: 700,
  label_2: 700,
  // Fabric close-ups feed the fabric_condition factor, which is 30% of the
  // grade — the weave has to be resolvable, not merely present.
  detail: 700,
  detail_2: 700,
  detail_3: 700,
  detail_4: 700,
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

/** The floor applied to any macro slot without its own entry above. */
export const DEFAULT_MIN_SHARPNESS = 0.22;

/** True when this photo slot is a macro shot the gate applies to. */
export function isMacroPhotoType(photoType: string | null | undefined): boolean {
  return !!photoType && photoType in MACRO_MIN_LONG_EDGE_PX;
}

/** The long-edge floor for a slot, or null when the slot is not a macro shot. */
export function minLongEdgeFor(photoType: string | null | undefined): number | null {
  if (!photoType) return null;
  return MACRO_MIN_LONG_EDGE_PX[photoType] ?? null;
}

/** The sharpness floor for a slot, or null when the slot is not a macro shot. */
export function minSharpnessFor(photoType: string | null | undefined): number | null {
  if (!isMacroPhotoType(photoType)) return null;
  return MACRO_MIN_SHARPNESS[photoType as string] ?? DEFAULT_MIN_SHARPNESS;
}

/** Friendly slot noun for the guidance copy ("tag", "serial number", …). */
function slotNoun(photoType: string): string {
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
): string {
  const noun = slotNoun(photoType);
  return reason === "low_resolution"
    ? `Move closer and fill the frame with the ${noun} — this shot is too small for AI to read reliably.`
    : `This ${noun} looks blurry. Hold steady, tap to focus, and retake it in good light.`;
}

export interface MacroPhotoMeasurement {
  photoType: string | null | undefined;
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
  const floor = minLongEdgeFor(m.photoType);
  if (floor == null) return { ok: true, reason: null, message: null, score: null };
  const photoType = m.photoType as string;

  // Resolution is checked first and reported alone: a too-small photo is also
  // usually a soft one, and "move closer" is the action that fixes both.
  if (m.longEdge != null && Number.isFinite(m.longEdge) && m.longEdge < floor) {
    return {
      ok: false,
      reason: "low_resolution",
      message: macroQualityMessage("low_resolution", photoType),
      score: m.sharpness,
    };
  }

  const sharpFloor = minSharpnessFor(photoType);
  if (
    m.sharpness != null &&
    Number.isFinite(m.sharpness) &&
    sharpFloor != null &&
    m.sharpness < sharpFloor
  ) {
    return {
      ok: false,
      reason: "unsharp",
      message: macroQualityMessage("unsharp", photoType),
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
): Promise<MacroPhotoMeasurement> {
  const unmeasured: MacroPhotoMeasurement = {
    photoType,
    longEdge: null,
    sharpness: null,
  };
  // Only pay for the decode on slots the gate actually applies to.
  if (!isMacroPhotoType(photoType)) return unmeasured;

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
    if (!ctx) return { photoType, longEdge, sharpness: null };
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
      longEdge,
      sharpness: normalizeSharpness(laplacianVariance(gray, w, h)),
    };
  } catch {
    // Decode/canvas failures are ours, not the seller's — fail open.
    return unmeasured;
  }
}
