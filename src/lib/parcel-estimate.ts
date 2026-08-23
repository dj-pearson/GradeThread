// Predicts the parcel a garment ships in, from the measurements grading
// already took (US-2790).
//
// WHY IT EXISTS. listing-profit.ts takes a shippingCost "if known", and it is
// almost never known: autolister-bulk-edit.tsx passes none at all, so the bulk
// "floor at X% margin" button prices every draft as if postage were free. On a
// wool coat that floor is a loss, applied in bulk, silently.
//
// DETERMINISTIC ON PURPOSE. This runs on every keystroke in the composer, so
// it must be free, and it must return the same number twice so the predicted
// figure can be regression-tested against real shipments later. An AI call is
// neither.
//
// MIRROR: this file is duplicated VERBATIM at
//   services/edge-functions/src/lib/parcel-estimate.ts
// because the Deno edge runtime cannot import from the Vite `src/` tree, and
// src/lib/__tests__/parcel-estimate.test.ts fails the build if the copies
// drift. Keep this module dependency-free (pure constants + pure functions)
// so it type-checks under BOTH tsconfig and Deno.
//
// ⚠ NO IMPORTS AT ALL, INCLUDING TYPE-ONLY ONES. The design said to
// `import type { GarmentCategory } from "@/types/database"` on the grounds
// that a type import erases at runtime. It does — and `deno check` still has
// to RESOLVE it, and `@/` is a Vite alias Deno knows nothing about:
//
//   TS2307: Import "@/types/database" not a dependency and not in import map
//
// So the category union is declared locally, which is exactly what the pattern
// this file was told to copy (src/lib/ebay-fees.ts) does — it has no imports
// either. The union is then held equal to the real `GarmentCategory` by a
// type-level assertion in the test, which runs on the web side where the
// canonical type IS available. Drift in either direction fails the build.
//
// THE NUMBERS BELOW ARE SEEDED ESTIMATES, not measurements. They are roughly
// right and individually unproven. The predicted-vs-actual feedback loop is
// the plan for making them real. Do not present them as sourced.

/**
 * The garment categories this estimator prices.
 *
 * Kept in step with `GarmentCategory` in src/types/database.ts by
 * parcel-estimate.test.ts, which asserts assignability BOTH ways — a new
 * category added to the database enum fails there until it gets a weight,
 * rather than silently falling through to `other` and shipping a wrong number.
 */
export type ParcelGarmentCategory =
  | "t-shirt" | "shirt" | "blouse" | "sweater" | "hoodie"
  | "jacket" | "coat" | "jeans" | "pants" | "shorts"
  | "skirt" | "dress" | "sneakers" | "boots" | "sandals"
  | "hat" | "bag" | "belt" | "scarf" | "neckwear" | "gloves" | "other";

/** Bumped whenever a weight, multiplier or pack rule changes, so a stored
 *  prediction can be attributed to the table that produced it. */
export const PARCEL_TABLE_VERSION = "parcel_v1_seeded";

/** Base garment weight in ounces at a reference size (men's M / US 8),
 *  EXCLUDING packaging. Seeded estimates, see the header. */
export const BASE_WEIGHT_OZ: Record<ParcelGarmentCategory, number> = {
  "t-shirt": 5.5,
  shirt: 8,
  blouse: 5,
  sweater: 16,
  hoodie: 22,
  jacket: 28,
  coat: 48,
  jeans: 22,
  pants: 16,
  shorts: 9,
  skirt: 8,
  dress: 12,
  sneakers: 32,
  boots: 48,
  sandals: 16,
  hat: 4,
  bag: 20,
  belt: 6,
  scarf: 4,
  neckwear: 2,
  gloves: 4,
  other: 12,
};

// Ordered longest-first so "polyester" is not matched by a shorter "poly"
// entry placed before it. Substring matching against a lowercased material
// string, because sellers write "100% cotton" and "cotton/poly blend".
export const MATERIAL_MULTIPLIERS: ReadonlyArray<[string, number]> = [
  ["leather", 1.6],
  ["corduroy", 1.2],
  ["polyester", 0.85],
  ["cashmere", 0.9],
  ["denim", 1.35],
  ["fleece", 1.1],
  ["cotton", 1.0],
  ["linen", 0.9],
  ["nylon", 0.8],
  ["rayon", 0.85],
  ["silk", 0.7],
  ["wool", 1.25],
  ["down", 0.75],
];

/** Flat reference measurement in inches at the base size, per axis. */
const REFERENCE_CHEST_IN = 21;
const REFERENCE_WAIST_IN = 17;

/**
 * Footwear is measured by SHOE SIZE, not by a tape measurement.
 *
 * Before this, sizeFactor read only chest or waist, so it returned null for
 * every shoe and the estimate was the category base alone — a men's 13 boot
 * and a women's 6 boot both came out at 48 oz. Shoe size is the one number a
 * shoe listing always carries, so it is the best signal available and it was
 * being ignored.
 *
 * THE EXPONENT IS LOWER THAN THE GARMENT ONE, deliberately. A garment scales
 * in two dimensions and its weight roughly tracks fabric area. A shoe is
 * graded mostly along its length: the upper and the outsole grow, the
 * midsole stack does not. Published weights across a single sneaker model run
 * about 2-3% per half size, which is what 0.6 reproduces over this range —
 * a US 13 lands near 1.2x a US 8 rather than the 1.6x a linear rule gives.
 *
 * US MEN'S is the reference scale because that is what `size_us` held when
 * this was written (measurement-templates.ts: shoes -> size_us, "US size",
 * required) and it stays the reference: `sizeScale` now says which scale the
 * number is on and it is normalised to US men's before the exponent (US-2796).
 * An ABSENT scale still means US men's, so every stored row keeps the exact
 * number it produced before — that is a deliberate compatibility promise and
 * it is test-guarded, not an oversight.
 */
const REFERENCE_SHOE_US_MEN = 9;
const SHOE_SIZE_EXPONENT = 0.6;

/** The scale a stored `size_us` number is actually on. */
export type ShoeSizeScale = "us_men" | "us_women" | "uk" | "eu" | "jp";

/**
 * EU/JP anchors -> US men's. Only these two scales need a table: US women's
 * and UK are exactly linear against US men's across the whole run
 * (usMen = usWomen - 1.5, usMen = uk + 0.5), while EU steps irregularly
 * (36,37,38.5,40,41,42.5,...) and JP is a foot length in cm.
 *
 * DUPLICATION IS DELIBERATE AND PINNED. The canonical table is SHOE_SIZES in
 * src/lib/size-conversion.ts, which this module may not import: it is mirrored
 * verbatim into the Deno edge tree and has to stay dependency-free. So these
 * anchors are checked against SHOE_SIZES by a test rather than by the type
 * system — see parcel-estimate.test.ts. Change the canonical table and that
 * test fails until this one follows.
 */
const EU_TO_US_MEN: readonly (readonly [number, number])[] = [
  [36, 4], [37, 5], [38.5, 6], [40, 7], [41, 8],
  [42.5, 9], [44, 10], [45, 11], [46, 12], [47.5, 13],
];
const JP_TO_US_MEN: readonly (readonly [number, number])[] = [
  [22.5, 4], [23.5, 5], [24, 6], [25, 7], [26, 8],
  [27, 9], [28, 10], [29, 11], [30, 12], [31, 13],
];

/** Piecewise-linear lookup, clamped to the table's ends. */
function interpolate(
  table: readonly (readonly [number, number])[],
  value: number,
): number {
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]!;
    if (value <= x1) {
      const [x0, y0] = table[i - 1]!;
      // x1 > x0 for every adjacent pair in both tables, so this cannot
      // divide by zero; the guard above already handled value <= x0.
      return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

/**
 * Convert a shoe size on any supported scale to the US men's number the
 * weight model is calibrated against. A null/unknown scale is treated as US
 * men's, which is what every row recorded before US-2796 meant.
 */
export function shoeSizeToUsMen(
  value: number,
  scale: ShoeSizeScale | null | undefined,
): number {
  if (!Number.isFinite(value)) return value;
  switch (scale) {
    case "us_women":
      return value - 1.5;
    case "uk":
      return value + 0.5;
    case "eu":
      return interpolate(EU_TO_US_MEN, value);
    case "jp":
      return interpolate(JP_TO_US_MEN, value);
    default:
      return value;
  }
}

/** Categories sized by shoe size rather than by a tape measurement. */
const SHOE_SIZED: ReadonlySet<string> = new Set([
  "sneakers",
  "boots",
  "sandals",
]);

/** Categories measured at the waist rather than the chest. */
const WAIST_MEASURED: ReadonlySet<string> = new Set([
  "jeans",
  "pants",
  "shorts",
  "skirt",
]);

// Weight scales with fabric area, which would argue for an exponent above 1.
// It is 1.0 here because we have no data yet, and a damped guess beats a
// confident one. The feedback loop decides whether it should rise.
const SIZE_EXPONENT = 1.0;
const SIZE_FACTOR_MIN = 0.75;
const SIZE_FACTOR_MAX = 1.45;

/** Weight of the packaging itself, in ounces. */
export const PACKAGING_WEIGHT_OZ = {
  mailer_small: 0.5,
  mailer_large: 0.9,
  box_small: 5,
  box_medium: 8,
} as const;

export type PackKind = keyof typeof PACKAGING_WEIGHT_OZ;

/** Outside dimensions in inches, used for dimensional weight. Seeded, like the
 *  weights above — these are ordinary mailer and shoebox sizes, not measured. */
export const PACK_DIMENSIONS: Record<
  PackKind,
  { lengthIn: number; widthIn: number; heightIn: number }
> = {
  mailer_small: { lengthIn: 10, widthIn: 13, heightIn: 1 },
  mailer_large: { lengthIn: 14, widthIn: 19, heightIn: 3 },
  box_small: { lengthIn: 12, widthIn: 9, heightIn: 4 },
  box_medium: { lengthIn: 16, widthIn: 12, heightIn: 8 },
};

// ⚠ 139, NOT 166. The design draft carried 166 with a note to verify it against
// the carrier before trusting it. Verified 2026-08-22 against USPS's own
// Domestic Mail Manual — Priority Mail DMM 123 and Ground Advantage DMM 283
// both publish 139 — and recorded in docs/shipping/usps-dim-weight-CONFIRMED.csv
// with the URLs and the date. 166 is the UPS/FedEx retail divisor.
//
// The error ran in the expensive direction, which is why the sourcing step is
// a step: a LARGER divisor yields a SMALLER dimensional weight, so the parcel
// bills lighter than it will, the margin floor sits lower than it should, and
// the seller loses the difference. That is the same failure this whole module
// exists to stop, arriving through the fix.
export const DIM_DIVISOR = 139;
export const DIM_THRESHOLD_CU_IN = 1728;

/**
 * Billable dimensional weight in ounces, or 0 when the rule does not apply.
 *
 * USPS publishes this as whole POUNDS, rounded UP — "divide the result by 139
 * and round up ... to determine the dimensional weight in pounds" — so the
 * ceiling is applied before converting to ounces rather than after. Rounding
 * in ounces would under-report by up to 15 oz on a parcel that is already the
 * expensive kind.
 *
 * The threshold is strict: the rule engages only ABOVE 1,728 cubic inches
 * (one cubic foot), so a parcel exactly at it bills on actual weight.
 */
export function dimensionalWeightOzForCubicInches(cubicInches: number): number {
  // Number.isFinite first, and it is load-bearing rather than defensive
  // decoration: Infinity > 1728 is TRUE, so an infinite volume would sail past
  // the threshold and return Infinity ounces, which Math.max then makes the
  // billable weight, which reaches the margin floor. Found by a test case, not
  // by reading. US-2739 hit the same shape in stepPrice, where an Infinity step
  // turned a real price into NaN.
  if (!Number.isFinite(cubicInches)) return 0;
  if (!(cubicInches > DIM_THRESHOLD_CU_IN)) return 0;
  return Math.ceil(cubicInches / DIM_DIVISOR) * 16;
}

/**
 * The same rule for a named pack.
 *
 * ⚠ TAKES CUBIC INCHES SEPARATELY ON PURPOSE. This started as one function
 * over PackKind, and a sabotage run showed the arithmetic was UNREACHABLE: no
 * seeded pack exceeds a cubic foot, so every call returned 0 and swapping the
 * round-up for a round-nearest, or making the threshold inclusive, changed
 * nothing that any test could see. The only cases covering the formula were
 * re-implementing it inline, which is a test asserting against its own copy of
 * the thing it checks.
 *
 * Splitting it means the rule is exercised at sizes that trip it, today,
 * without inventing a pack size to make that happen.
 */
export function dimensionalWeightOz(pack: PackKind): number {
  const d = PACK_DIMENSIONS[pack];
  return dimensionalWeightOzForCubicInches(d.lengthIn * d.widthIn * d.heightIn);
}

export interface ParcelInput {
  garmentCategory: ParcelGarmentCategory | null;
  material: string | null;
  measurements: Record<string, number | string> | null;
  size: string | null;
  /**
   * Which scale `measurements.size_us` is on (US-2796). OPTIONAL on purpose:
   * callers that predate the field keep their exact previous output, because
   * absent means US men's.
   */
  sizeScale?: ShoeSizeScale | null;
}

export interface ParcelEstimate {
  /** Predicted actual weight in ounces, packaging included. */
  weightOz: number;
  /** max(actual, dimensional). Equal to weightOz whenever the parcel is under
   *  one cubic foot, which every current pack is - see the test. */
  billableWeightOz: number;
  pack: PackKind;
  /** "good" when measurements and material both informed the number. */
  confidence: "good" | "rough";
  /** Which inputs were used, in a fixed order, for the UI and for debugging. */
  basis: string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Reads a numeric measurement, tolerating the string values the jsonb holds. */
function numeric(
  measurements: Record<string, number | string> | null,
  key: string,
): number | null {
  if (!measurements) return null;
  const raw = measurements[key];
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function materialMultiplier(material: string | null): number | null {
  if (!material) return null;
  const hay = material.toLowerCase();
  for (const [needle, mult] of MATERIAL_MULTIPLIERS) {
    if (hay.includes(needle)) return mult;
  }
  return null;
}

export function sizeFactor(input: ParcelInput): number | null {
  const cat = input.garmentCategory;
  if (!cat) return null;

  if (SHOE_SIZED.has(cat)) {
    const raw = numeric(input.measurements, "size_us");
    if (raw == null) return null;
    // Normalise to US men's first: a women's 9 and a men's 9 are about an inch
    // of last length apart, and the exponent below assumes one scale.
    const us = shoeSizeToUsMen(raw, input.sizeScale);
    if (!(us > 0)) return null;
    const ratio = Math.pow(us / REFERENCE_SHOE_US_MEN, SHOE_SIZE_EXPONENT);
    return clamp(ratio, SIZE_FACTOR_MIN, SIZE_FACTOR_MAX);
  }

  const useWaist = WAIST_MEASURED.has(cat);
  const measured = useWaist
    ? numeric(input.measurements, "waist")
    : numeric(input.measurements, "chest");
  if (measured == null) return null;
  const reference = useWaist ? REFERENCE_WAIST_IN : REFERENCE_CHEST_IN;
  const ratio = Math.pow(measured / reference, SIZE_EXPONENT);
  return clamp(ratio, SIZE_FACTOR_MIN, SIZE_FACTOR_MAX);
}

/** Categories that ship rigid, in a box rather than a mailer. */
const BOXED: ReadonlySet<string> = new Set([
  "sneakers",
  "boots",
  "sandals",
  "bag",
]);

/** Above this many ounces of garment, a small mailer stops fitting. */
const LARGE_MAILER_OZ = 18;

function selectPack(input: ParcelInput, garmentOz: number): PackKind {
  const cat = input.garmentCategory;
  if (cat != null && BOXED.has(cat)) {
    return garmentOz > 36 ? "box_medium" : "box_small";
  }
  return garmentOz > LARGE_MAILER_OZ ? "mailer_large" : "mailer_small";
}

export function estimateParcel(input: ParcelInput): ParcelEstimate {
  const basis: string[] = [];
  const cat = input.garmentCategory;
  const base = cat != null ? BASE_WEIGHT_OZ[cat] : BASE_WEIGHT_OZ.other;
  if (cat != null) basis.push("category");

  const factor = sizeFactor(input);
  if (factor != null) basis.push("measurements");

  const mult = materialMultiplier(input.material);
  if (mult != null) basis.push("material");

  const garmentOz = base * (factor ?? 1) * (mult ?? 1);
  const pack = selectPack(input, garmentOz);
  const weightOz = garmentOz + PACKAGING_WEIGHT_OZ[pack];

  // The bulky-and-light case, which is where sellers lose the most and see it
  // the least: a puffer weighs almost nothing and bills like a brick. `basis`
  // gains "dimensional" only when it actually WON, so the UI can say which
  // number it is showing rather than implying both were considered equally.
  const dimOz = dimensionalWeightOz(pack);
  const billableWeightOz = Math.max(weightOz, dimOz);
  if (dimOz > weightOz) basis.push("dimensional");

  return {
    weightOz,
    billableWeightOz,
    pack,
    confidence: factor != null && mult != null ? "good" : "rough",
    basis,
  };
}
