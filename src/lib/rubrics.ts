import { GRADE_FACTORS, type GradeFactorKey } from "@/lib/constants";

// Category-specific grading rubrics (client view).
//
// A rubric is the set of weighted factors a category is condition-graded on.
// Clothing's rubric is the historical 5-factor model and is derived directly
// from GRADE_FACTORS so the two can never drift. Non-clothing rubrics
// (sports_cards / watches / shoes) describe the factors those items are graded
// on; they're used to render the certificate's Factor Breakdown when a report
// carries a generic `factor_scores` map + `rubric_key` (see migration 00231).
//
// NOTE: condition grading itself is still clothing-only at the pipeline level —
// these definitions drive presentation and are the shared source of truth for
// the activation phase. The server mirror lives in
// services/edge-functions/src/lib/rubric.ts and MUST stay in sync.

export interface RubricFactor {
  /** Stable key stored in grade_reports.factor_scores. */
  key: string;
  /** Human label shown on the certificate. */
  label: string;
  /** Weight in the overall score; a rubric's weights sum to 1.0. */
  weight: number;
}

export interface Rubric {
  /** Matches grade_reports.rubric_key and (for non-clothing) item_category. */
  key: string;
  label: string;
  factors: RubricFactor[];
}

/**
 * Rubrics whose items collide with the authenticity add-on (US-2225 AC3).
 *
 * Not a style note — a liability one. Every authentication tell pack we hold is
 * for a bag brand (louisvuitton, coach, gucci), so on a handbag the condition
 * grade and the authenticity verdict land on the SAME certificate. A buyer
 * reading "9.2" beside a luxury logo will take it as a statement about whether
 * the bag is real unless the page says it is not.
 *
 * Mirrors AUTHENTICITY_ADJACENT_RUBRIC_KEYS in the server rubric module.
 */
export const AUTHENTICITY_ADJACENT_RUBRIC_KEYS: readonly string[] = ["bags"];

/**
 * The fixed line that keeps a condition grade from reading as an authenticity
 * claim. A constant, and never model-authored, for the same reason the
 * authenticity limitations text is: the model must not be able to soften it.
 */
export const CONDITION_NOT_AUTHENTICITY_DISCLOSURE =
  "This is a condition grade only. It is not an opinion on whether this item is authentic.";

/** Does this rubric need the condition-vs-authenticity separation shown? */
export function needsAuthenticitySeparation(rubricKey: string | null | undefined): boolean {
  return !!rubricKey && AUTHENTICITY_ADJACENT_RUBRIC_KEYS.includes(rubricKey);
}

// Clothing = the existing 5 factors, derived from GRADE_FACTORS (zero drift).
const CLOTHING_FACTORS: RubricFactor[] = (
  Object.entries(GRADE_FACTORS) as [GradeFactorKey, { label: string; weight: number }][]
).map(([key, v]) => ({ key, label: v.label, weight: v.weight }));

const CLOTHING_RUBRIC: Rubric = {
  key: "clothing",
  label: "Clothing",
  factors: CLOTHING_FACTORS,
};

export const RUBRICS: Record<string, Rubric> = {
  clothing: CLOTHING_RUBRIC,
  // US-2223. Hats and caps. Inert until item_category gains 'headwear' — the
  // weights' reasoning is in the server module. Pinned by the fixture.
  headwear: {
    key: "headwear",
    label: "Hats & caps",
    factors: [
      { key: "crown_structure", label: "Crown & Structure", weight: 0.25 },
      { key: "brim", label: "Brim", weight: 0.25 },
      { key: "sweatband", label: "Sweatband", weight: 0.2 },
      { key: "fabric_graphics", label: "Fabric & Graphics", weight: 0.2 },
      { key: "hardware_closure", label: "Hardware & Closure", weight: 0.1 },
    ],
  },
  // US-2224. Ties, belts, scarves and gloves share one rubric; the decision and
  // its weakness are recorded in the server module. Pinned by the fixture.
  accessories: {
    key: "accessories",
    label: "Ties, belts, scarves & gloves",
    factors: [
      { key: "material_condition", label: "Material Condition", weight: 0.3 },
      { key: "structure_shape", label: "Structure & Shape", weight: 0.25 },
      { key: "edges_terminations", label: "Edges & Terminations", weight: 0.2 },
      { key: "hardware_fastening", label: "Hardware & Fastening", weight: 0.15 },
      { key: "cleanliness", label: "Cleanliness", weight: 0.1 },
    ],
  },
  // US-2225. Mirrors the server rubric; the weights' reasoning lives there.
  // Pinned by src/test/fixtures/rubric-factors.json, asserted by both suites.
  bags: {
    key: "bags",
    label: "Handbag & leather goods",
    factors: [
      { key: "corners_edges", label: "Corners & Edges", weight: 0.3 },
      { key: "exterior", label: "Exterior", weight: 0.2 },
      { key: "handles_straps", label: "Handles & Straps", weight: 0.15 },
      { key: "hardware", label: "Hardware", weight: 0.15 },
      { key: "interior", label: "Interior", weight: 0.1 },
      { key: "structure", label: "Structure", weight: 0.1 },
    ],
  },
  sports_cards: {
    key: "sports_cards",
    label: "Sports card",
    factors: [
      { key: "surface", label: "Surface", weight: 0.3 },
      { key: "corners", label: "Corners", weight: 0.25 },
      { key: "edges", label: "Edges", weight: 0.25 },
      { key: "centering", label: "Centering", weight: 0.2 },
    ],
  },
  watches: {
    key: "watches",
    label: "Watch",
    factors: [
      { key: "dial_hands", label: "Dial & Hands", weight: 0.3 },
      { key: "case_bracelet", label: "Case & Bracelet", weight: 0.25 },
      { key: "crystal", label: "Crystal", weight: 0.2 },
      { key: "movement_function", label: "Movement & Function", weight: 0.15 },
      { key: "cosmetic", label: "Cosmetic", weight: 0.1 },
    ],
  },
  shoes: {
    key: "shoes",
    label: "Shoes",
    factors: [
      { key: "upper", label: "Upper", weight: 0.3 },
      { key: "outsole", label: "Outsole & Tread", weight: 0.25 },
      { key: "structure", label: "Structure", weight: 0.2 },
      { key: "cosmetic", label: "Cosmetic", weight: 0.15 },
      { key: "interior_odor", label: "Interior & Odor", weight: 0.1 },
    ],
  },
};

/** Resolves the rubric for a rubric_key / item_category; clothing is the default. */
export function rubricForKey(key: string | null | undefined): Rubric {
  if (!key) return CLOTHING_RUBRIC;
  return RUBRICS[key] ?? CLOTHING_RUBRIC;
}

// ---------------------------------------------------------------------------
// Rubric-driven weighted overall (US-1997) — mirror of the edge implementation
// in services/edge-functions/src/lib/rubric.ts. Same arithmetic, same 0.1
// rounding, same refusal, same error message.
// ---------------------------------------------------------------------------
//
// The web already has ONE weighted-overall (src/lib/weighted-grade.ts), and it
// is not this: that one is hard-typed to the five clothing factors keyed by
// their grade_reports COLUMN names, which is the shape every admin surface
// edits. This one is keyed by a rubric's own factor keys — the shape
// grade_reports.factor_scores stores — and works for any factor set. Both
// exist on purpose; for clothing they return the same number on the same
// input, and that is asserted rather than assumed (rubrics.test.ts runs the
// shared weighted-grade fixture through both).
//
// NO CLAMP, deliberately — see the edge mirror for the reasoning.

/**
 * A rubric's weights must sum to 1.0. Floating-point exact equality is the
 * wrong test for that, so callers and suites compare within this tolerance.
 */
export const RUBRIC_WEIGHT_SUM_TOLERANCE = 1e-9;

/** Sum of a rubric's factor weights. Should be 1.0 for every rubric. */
export function rubricWeightSum(rubric: Rubric): number {
  return rubric.factors.reduce((total, factor) => total + factor.weight, 0);
}

function requireRubricFactor(
  rubric: Rubric,
  scores: Record<string, number>,
  key: string,
): number {
  const value = scores[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `computeRubricWeightedOverall: factor "${key}" of rubric ` +
        `"${rubric.key}" is missing or not finite (got ${String(value)}). ` +
        `Refusing to compute a weighted overall from an incomplete factor set.`,
    );
  }
  return value;
}

/**
 * The weighted overall for ANY rubric, rounded to 0.1.
 *
 * `scores` is keyed by the rubric's own factor keys — the shape
 * grade_reports.factor_scores (migration 00231) stores for a non-clothing
 * report.
 */
export function computeRubricWeightedOverall(
  rubric: Rubric,
  scores: Record<string, number>,
): number {
  let total = 0;
  for (const factor of rubric.factors) {
    total += requireRubricFactor(rubric, scores, factor.key) * factor.weight;
  }
  return Math.round(total * 10) / 10;
}
