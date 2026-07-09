// US-1778: deterministic, explainable fit engine. Compares a garment's flat-lay
// measurements (inches) to a buyer's body measurements (inches, US-1777) and
// produces a per-dimension + overall fit verdict, a size recommendation, and the
// limiting dimension. No AI, no black box — every verdict traces to an ease
// value against a published tolerance band.
//
// UNIT CARE (the note in US-1778): a garment "chest" is a FLAT pit-to-pit
// measurement, so its circumference is flat × 2; a body "chest" is already a
// circumference. Circumference dimensions double the garment value before
// comparing; length dimensions (inseam, sleeve) compare directly.

import type { MeasurementGroup } from "@/lib/measurement-templates";

export type FitVerdict = "too_small" | "slim" | "true" | "relaxed" | "too_big";

export interface DimensionFit {
  dimension: string;
  label: string;
  /** Garment circumference/length in inches (after any flat→circumference x2). */
  garmentValue: number;
  bodyValue: number;
  /** garmentValue − bodyValue (ease for circumference, delta for length). */
  ease: number;
  verdict: FitVerdict;
}

export interface FitResult {
  status: "ok" | "insufficient";
  verdict: FitVerdict | null;
  confidence: number;
  sizeRecommendation: string;
  limitingDimension: string | null;
  dimensions: DimensionFit[];
  reason?: string;
}

interface CircBands {
  kind: "circ";
  tooSmall: number;
  slim: number;
  true: number;
  relaxed: number;
}
interface LengthBands {
  kind: "length";
  tooShort: number; // delta below this → too short (too_small)
  tooLong: number; // delta above this → too long (too_big)
}

interface DimSpec {
  name: string;
  label: string;
  /** Garment measurement keys to try, in order (first present wins). */
  garmentKeys: string[];
  bodyKey: string;
  /** 2 for a flat measurement whose circumference is flat×2; 1 for length/width. */
  multiply: 1 | 2;
  bands: CircBands | LengthBands;
}

// Ease tolerances per garment group (inches). Ready-to-wear ease: tops sit close,
// outerwear needs layering room, bottoms fit tight at the waist.
const TOP_CHEST: CircBands = { kind: "circ", tooSmall: 0, slim: 3, true: 6, relaxed: 10 };
const OUTER_CHEST: CircBands = { kind: "circ", tooSmall: 2, slim: 6, true: 11, relaxed: 16 };
const DRESS_CHEST: CircBands = { kind: "circ", tooSmall: 0, slim: 3, true: 6, relaxed: 10 };
const WAIST: CircBands = { kind: "circ", tooSmall: -1, slim: 1, true: 3, relaxed: 5 };
const HIPS: CircBands = { kind: "circ", tooSmall: 0, slim: 2, true: 5, relaxed: 8 };
const SHOULDER: CircBands = { kind: "circ", tooSmall: -0.5, slim: 0.75, true: 2, relaxed: 3.5 };
const SLEEVE: LengthBands = { kind: "length", tooShort: -2, tooLong: 2.5 };
const INSEAM: LengthBands = { kind: "length", tooShort: -1.5, tooLong: 2.5 };

const CHEST = (bands: CircBands): DimSpec => ({
  name: "chest",
  label: "Chest",
  garmentKeys: ["chest", "bust"],
  bodyKey: "chest",
  multiply: 2,
  bands,
});

const GROUP_DIMS: Record<MeasurementGroup, DimSpec[]> = {
  top: [
    CHEST(TOP_CHEST),
    { name: "shoulder", label: "Shoulder", garmentKeys: ["shoulder"], bodyKey: "shoulder", multiply: 1, bands: SHOULDER },
    { name: "sleeve", label: "Sleeve", garmentKeys: ["sleeve"], bodyKey: "sleeve", multiply: 1, bands: SLEEVE },
  ],
  outerwear: [
    CHEST(OUTER_CHEST),
    { name: "shoulder", label: "Shoulder", garmentKeys: ["shoulder"], bodyKey: "shoulder", multiply: 1, bands: SHOULDER },
    { name: "sleeve", label: "Sleeve", garmentKeys: ["sleeve"], bodyKey: "sleeve", multiply: 1, bands: SLEEVE },
  ],
  bottom: [
    { name: "waist", label: "Waist", garmentKeys: ["waist"], bodyKey: "waist", multiply: 2, bands: WAIST },
    { name: "hips", label: "Hips", garmentKeys: ["hip"], bodyKey: "hips", multiply: 2, bands: HIPS },
    { name: "inseam", label: "Inseam", garmentKeys: ["inseam"], bodyKey: "inseam", multiply: 1, bands: INSEAM },
  ],
  dress: [
    CHEST(DRESS_CHEST),
    { name: "waist", label: "Waist", garmentKeys: ["waist"], bodyKey: "waist", multiply: 2, bands: WAIST },
    { name: "hips", label: "Hips", garmentKeys: ["hip"], bodyKey: "hips", multiply: 2, bands: HIPS },
  ],
  shoes: [],
  watch: [],
  generic: [],
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function classify(spec: DimSpec, garmentVal: number, bodyVal: number): { ease: number; verdict: FitVerdict } {
  const ease = garmentVal - bodyVal;
  if (spec.bands.kind === "length") {
    if (ease < spec.bands.tooShort) return { ease, verdict: "too_small" };
    if (ease > spec.bands.tooLong) return { ease, verdict: "too_big" };
    return { ease, verdict: "true" };
  }
  const b = spec.bands;
  let verdict: FitVerdict;
  if (ease < b.tooSmall) verdict = "too_small";
  else if (ease < b.slim) verdict = "slim";
  else if (ease < b.true) verdict = "true";
  else if (ease < b.relaxed) verdict = "relaxed";
  else verdict = "too_big";
  return { ease, verdict };
}

// Worst-first severity: a garment that won't fit (too_small) or is way oversized
// (too_big) drives the overall read; slim/relaxed are acceptable variations.
const SEVERITY: Record<FitVerdict, number> = { too_small: 0, too_big: 1, slim: 2, relaxed: 3, true: 4 };

const SIZE_REC: Record<FitVerdict, string> = {
  too_small: "Size up — this will be tight on the limiting dimension.",
  slim: "True to size — expect a fitted/slim cut.",
  true: "True to size.",
  relaxed: "True to size — expect a relaxed, roomy cut.",
  too_big: "Size down — this will be roomy.",
};

/**
 * Predict how a garment fits a body. `garment` + `body` are inch-keyed maps
 * (garment by flat-lay keys, body by body keys). Returns an "insufficient"
 * status when no shared dimension can be compared (US-1778 AC3).
 */
export function predictFit(
  group: MeasurementGroup,
  garment: Record<string, unknown>,
  body: Record<string, unknown>,
): FitResult {
  const specs = GROUP_DIMS[group] ?? [];
  const dimensions: DimensionFit[] = [];

  for (const spec of specs) {
    const bodyVal = num(body[spec.bodyKey]);
    if (bodyVal == null) continue;
    let garmentFlat: number | null = null;
    for (const gk of spec.garmentKeys) {
      const v = num(garment[gk]);
      if (v != null) {
        garmentFlat = v;
        break;
      }
    }
    if (garmentFlat == null) continue;
    const garmentValue = garmentFlat * spec.multiply;
    const { ease, verdict } = classify(spec, garmentValue, bodyVal);
    dimensions.push({
      dimension: spec.name,
      label: spec.label,
      garmentValue: Math.round(garmentValue * 10) / 10,
      bodyValue: bodyVal,
      ease: Math.round(ease * 10) / 10,
      verdict,
    });
  }

  if (dimensions.length === 0) {
    return {
      status: "insufficient",
      verdict: null,
      confidence: 0,
      sizeRecommendation: "Add more measurements to get a fit read.",
      limitingDimension: null,
      dimensions: [],
      reason:
        group === "shoes" || group === "watch" || group === "generic"
          ? "Fit prediction isn't available for this item type."
          : "This item and your profile don't share enough measurements to compare.",
    };
  }

  // The limiting dimension is the worst-fitting one; the overall verdict follows it.
  const limiting = dimensions.reduce((worst, d) =>
    SEVERITY[d.verdict] < SEVERITY[worst.verdict] ? d : worst
  );
  const verdict = limiting.verdict;

  // Confidence grows with how many dimensions we could compare, capped — a
  // measurements-only read is never certain.
  const confidence = Math.min(0.9, 0.45 + 0.15 * dimensions.length);

  return {
    status: "ok",
    verdict,
    confidence: Math.round(confidence * 100) / 100,
    sizeRecommendation: SIZE_REC[verdict],
    limitingDimension: limiting.dimension,
    dimensions,
  };
}

const VERDICT_LABEL: Record<FitVerdict, string> = {
  too_small: "Too small",
  slim: "Slim / fitted",
  true: "True to size",
  relaxed: "Relaxed",
  too_big: "Too big",
};
export function fitVerdictLabel(v: FitVerdict): string {
  return VERDICT_LABEL[v];
}
