// US-2135 AC3, the READER. "Measure the delivered pixel density per macro region
// and record it, SO CONFIDENCE CAN BE CONDITIONED on real evidence quality
// rather than assumed" — 00613 shipped the recording and left the second half
// open, which its own note called out rather than glossed: a column with no
// consumer.
//
// WHAT THIS ASKS. For a dedicated macro slot the whole photo IS the region, so
// the delivered density of that region is the stored image's own long edge. The
// client compressed toward a per-slot cap; if what arrived is far short of it,
// the evidence is weaker than the slot promised — an older client that did not
// know the slot, a seller's original that was already small, a harder
// compression on bad mobile data. All of those mean the same thing to a grader
// and none of them are visible in the picture.
//
// ⚠ NULL IS UNKNOWN, NEVER ZERO, and this is the trap 00613's own header names:
// `Number(null)` is 0 and finite, so a naive reader turns "we did not measure
// this" into "worst possible evidence" and caps confidence on rows written
// before the column existed. Every function here refuses a null instead.
//
// ⚠ THE CAP TABLE IS A MIRROR. The authority is the web compressor
// (src/lib/macro-photo-quality.ts) — it is what actually resizes the bytes. This
// copy exists because the edge cannot import from src/. Both are asserted
// against src/test/fixtures/macro-upload-caps.json by their own suites, the same
// arrangement as rubric-factors.json (US-1997 AC4). Do not edit one alone.

/** Mirror of DEFAULT_UPLOAD_MAX_WIDTH_PX. */
export const DEFAULT_UPLOAD_MAX_WIDTH_PX = 2400;

/** Mirror of MACRO_UPLOAD_MAX_WIDTH_PX. */
export const MACRO_UPLOAD_MAX_WIDTH_PX: Readonly<Record<string, number>> = {
  serial: 3600,
  marking: 3600,
  surface: 3600,
  corner: 3600,
  sole: 3600,
  measurement: 3600,
  tag: 3000,
  label: 3000,
  detail: 3000,
  defect: 3000,
  interior: 3000,
  certificate: 3000,
};

/**
 * The cap a slot's upload was compressed toward.
 *
 * `image_type` carries a suffix on some slots (`detail_1`, `measurement_chest`),
 * so the base slot is the part before the first underscore. A type we do not
 * recognise gets the global default rather than a guess.
 */
export function capForSlot(imageType: string | null | undefined): number {
  const base = (imageType ?? "").trim().toLowerCase().split("_")[0] ?? "";
  return MACRO_UPLOAD_MAX_WIDTH_PX[base] ?? DEFAULT_UPLOAD_MAX_WIDTH_PX;
}

/** True for the slots whose whole purpose is fine detail. */
export function isMacroSlot(imageType: string | null | undefined): boolean {
  const base = (imageType ?? "").trim().toLowerCase().split("_")[0] ?? "";
  return base in MACRO_UPLOAD_MAX_WIDTH_PX;
}

export interface DeliveredImage {
  image_type: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Fraction of its slot's cap that an image actually delivered, or null when we
 * cannot tell. 1.0 means it arrived at the cap; 0.4 means it arrived at 40% of
 * the long edge the slot asked for.
 */
export function deliveredRatio(img: DeliveredImage): number | null {
  const w = img.width, h = img.height;
  if (typeof w !== "number" || typeof h !== "number") return null;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const longEdge = Math.max(w, h);
  const cap = capForSlot(img.image_type);
  if (cap <= 0) return null;
  return Number((longEdge / cap).toFixed(4));
}

/**
 * Below this fraction of its cap, a macro slot is treated as thin evidence.
 *
 * 0.5 — half the long edge the slot asked for, which is a QUARTER of the pixels.
 * Chosen high enough that ordinary variation does not trip it (a 3600-cap slot
 * shot on a phone that delivers 2400 is 0.67 and passes; that is the web default
 * and not a defect) and low enough to catch the case this exists for: a client
 * that never knew about macro slots and sent the 1600px iOS default into a 3600
 * slot, which is 0.44.
 */
export const MACRO_THIN_EVIDENCE_RATIO = 0.5;

/**
 * The confidence cap for a macro slot that came in thin.
 *
 * Equal to the partial-image cap TODAY and deliberately not written in terms of
 * it, for the same reason NO_FABRIC_CLOSEUP_CONFIDENCE_CAP is not: they mean
 * different things. That one is "an image the seller never took"; this is "an
 * image that arrived with a quarter of the detail it was supposed to carry".
 * They can move independently.
 */
export const THIN_MACRO_CONFIDENCE_CAP = 0.6;

export interface MacroDensityVerdict {
  /** Macro slots we could measure. */
  measured: number;
  /** Of those, how many landed under the threshold. */
  thin: number;
  /** Slot names that came in thin, for the report line. */
  thinSlots: string[];
  /** Cap to compose, or null when there is nothing to say. */
  confidenceCap: number | null;
  /** The detailed_notes line, or "" when there is nothing to record. */
  note: string;
}

/**
 * Assess the macro evidence actually delivered. Pure.
 *
 * Non-macro slots are ignored entirely — a front shot is not trying to resolve
 * stitch pitch and holding it to a macro bar would cap almost every grade.
 * Unmeasurable rows are ignored too, and counted nowhere: a submission whose
 * images all predate the column produces `measured: 0` and no cap, which is the
 * honest answer rather than a confident one.
 */
export function assessMacroDensity(
  images: readonly DeliveredImage[],
  threshold: number = MACRO_THIN_EVIDENCE_RATIO,
): MacroDensityVerdict {
  const thinSlots: string[] = [];
  let measured = 0;
  for (const img of images) {
    if (!isMacroSlot(img.image_type)) continue;
    const ratio = deliveredRatio(img);
    if (ratio === null) continue;
    measured++;
    if (ratio < threshold) {
      thinSlots.push(`${img.image_type} (${Math.round(ratio * 100)}% of its ${capForSlot(img.image_type)}px target)`);
    }
  }
  if (measured === 0 || thinSlots.length === 0) {
    return { measured, thin: 0, thinSlots: [], confidenceCap: null, note: "" };
  }
  return {
    measured,
    thin: thinSlots.length,
    thinSlots,
    confidenceCap: THIN_MACRO_CONFIDENCE_CAP,
    note:
      `Close-up evidence thinner than the slot asked for: ${thinSlots.join("; ")}. ` +
      `Fine detail (stitching, stamps, weave) may not be resolvable at this size, ` +
      `so the grade is confidence-capped and reviewed.`,
  };
}
