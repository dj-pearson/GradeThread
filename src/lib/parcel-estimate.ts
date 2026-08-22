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
