// Category-specific grading rubrics (server source of truth).
//
// Condition grading is currently clothing-only — see ai-grading.ts, whose
// FACTOR_WEIGHTS / FactorScores hardcode the 5 garment factors. This module
// defines the rubric PER item_category so the grading pipeline can, in the
// activation phase, select factors + weights + prompt guidance + defect routing
// by category instead of assuming clothing.
//
// NOT YET WIRED into the live pipeline, so clothing grading is byte-for-byte
// unchanged. The web mirror (src/lib/rubrics.ts) renders certificates from
// these definitions and MUST stay in sync (factor keys + weights + labels) —
// pinned by src/test/fixtures/rubric-factors.json, which both suites assert.
// The clothing weights here are identical to ai-grading.ts FACTOR_WEIGHTS.
//
// Activation checklist (US-1997 decided ACTIVATE; this is a multi-phase
// program, so the checklist records what is done and what is not):
//   1. TODO — Pass item_category into the grading pipeline (flipdesk-grading
//      currently maps it to garment_type; non-clothing has neither, and
//      submissions requires garment_type NOT NULL — de-gate that first).
//   2. Select the rubric by item_category; build the composite prompt from
//      rubric.factors + rubric.promptGuidance; compute the overall score from
//      these weights; route defects via rubric.defectRouting.
//      - DONE: the scoring math — computeRubricWeightedOverall below, pinned
//        against the clothing implementations it generalizes.
//      - TODO: the per-category composite prompts and defect routing. New
//        prompts reach live traffic ONLY through shadow → golden-set eval gate
//        → canary, and no non-clothing golden set exists yet (golden cases grow
//        from real human-corrected grades; they cannot be fabricated). That is
//        the gate this phase is waiting on, not a missing decision.
//   3. TODO — Persist grade_reports.factor_scores (JSONB) + rubric_key on ALL
//      write paths (insert + human-review reseal + adjustment, or the JSONB
//      goes stale against the typed columns); recreate the public_grade_reports
//      view to expose them. The public cert allowlist (content-public.ts
//      CERT_REPORT_COLUMNS) already carries both columns.

export interface RubricFactor {
  key: string;
  label: string;
  /** Weights within a rubric sum to 1.0. */
  weight: number;
  /** One-line description fed to the grading model. */
  guidance: string;
}

export interface Rubric {
  /** Matches item_category and grade_reports.rubric_key. */
  key: string;
  label: string;
  factors: RubricFactor[];
  /** Category framing prepended to the composite grading prompt. */
  promptGuidance: string;
  /**
   * Defect-type → factor weight routing for the deterministic defect-weighting
   * pass (mirrors defect-weighting.ts FACTOR_ROUTING, but per rubric). Keys are
   * factor keys of THIS rubric; values sum to ~1.0 per defect type. The shared
   * defect taxonomy (stain, rip_tear, …) is reused; unmapped defects fall back
   * to the rubric's first factor.
   */
  defectRouting: Record<string, Record<string, number>>;
}

const CLOTHING: Rubric = {
  key: "clothing",
  label: "Clothing",
  factors: [
    { key: "fabric_condition", label: "Fabric Condition", weight: 0.3, guidance: "Material integrity: pilling, thinning, holes, stains, fading." },
    { key: "structural_integrity", label: "Structural Integrity", weight: 0.25, guidance: "Seams, hems, construction, shape retention." },
    { key: "cosmetic_appearance", label: "Cosmetic Appearance", weight: 0.2, guidance: "Visual appeal, color consistency, print condition." },
    { key: "functional_elements", label: "Functional Elements", weight: 0.15, guidance: "Zippers, buttons, closures, pockets, elastic." },
    { key: "odor_cleanliness", label: "Odor & Cleanliness", weight: 0.1, guidance: "Cleanliness indicators, staining patterns." },
  ],
  promptGuidance:
    "Grade this garment's condition relative to its as-manufactured state. Intentional design features are not defects.",
  defectRouting: {
    stain: { odor_cleanliness: 0.6, cosmetic_appearance: 0.4 },
    rip_tear: { structural_integrity: 0.6, fabric_condition: 0.4 },
    broken_zipper: { functional_elements: 1.0 },
  },
};

const SPORTS_CARDS: Rubric = {
  key: "sports_cards",
  label: "Sports card",
  factors: [
    { key: "surface", label: "Surface", weight: 0.3, guidance: "Scratches, print lines, gloss, indentations, staining across the card face." },
    { key: "corners", label: "Corners", weight: 0.25, guidance: "Sharpness of all four corners; fraying, rounding, dings." },
    { key: "edges", label: "Edges", weight: 0.25, guidance: "Edge whitening, chipping, nicks along all four edges." },
    { key: "centering", label: "Centering", weight: 0.2, guidance: "Front/back border symmetry left-right and top-bottom." },
  ],
  promptGuidance:
    "Grade this trading card like a condition grader (PSA/BGS-style intuition, NOT an official slab grade). Assess surface, corners, edges, and centering independently. Factory print artifacts are not handling damage.",
  defectRouting: {
    crease: { surface: 0.7, corners: 0.3 },
    corner_ding: { corners: 1.0 },
    edge_whitening: { edges: 1.0 },
    surface_scratch: { surface: 1.0 },
    off_center: { centering: 1.0 },
  },
};

const WATCHES: Rubric = {
  key: "watches",
  label: "Watch",
  factors: [
    { key: "dial_hands", label: "Dial & Hands", weight: 0.3, guidance: "Dial blemishes, lume condition, hand alignment, patina." },
    { key: "case_bracelet", label: "Case & Bracelet", weight: 0.25, guidance: "Case scratches/dings, bracelet/strap wear, clasp condition, stretch." },
    { key: "crystal", label: "Crystal", weight: 0.2, guidance: "Scratches, chips, cracks on the crystal." },
    { key: "movement_function", label: "Movement & Function", weight: 0.15, guidance: "Running condition, complications, crown/pusher action (as observable)." },
    { key: "cosmetic", label: "Cosmetic", weight: 0.1, guidance: "Overall presentation, polish, originality of finish." },
  ],
  promptGuidance:
    "Grade this watch's condition from the photos. Distinguish honest wear from damage; do NOT assert authenticity or service history beyond what's visible.",
  defectRouting: {
    scratch: { case_bracelet: 0.6, crystal: 0.4 },
    crack: { crystal: 1.0 },
    stretched_misshapen: { case_bracelet: 1.0 },
  },
};

const SHOES: Rubric = {
  key: "shoes",
  label: "Shoes",
  factors: [
    { key: "upper", label: "Upper", weight: 0.3, guidance: "Creasing, scuffs, stains, material integrity of the upper." },
    { key: "outsole", label: "Outsole & Tread", weight: 0.25, guidance: "Tread wear, sole separation, yellowing, heel drag." },
    { key: "structure", label: "Structure", weight: 0.2, guidance: "Shape retention, heel counter, midsole compression/cracking." },
    { key: "cosmetic", label: "Cosmetic", weight: 0.15, guidance: "Overall presentation, color, laces, branding." },
    { key: "interior_odor", label: "Interior & Odor", weight: 0.1, guidance: "Insole wear, interior cleanliness, odor indicators." },
  ],
  promptGuidance:
    "Grade these shoes' condition from the photos, including the outsole. Distinguish normal break-in from damage.",
  defectRouting: {
    abrasion_thinning: { upper: 0.6, cosmetic: 0.4 },
    rip_tear: { upper: 0.6, structure: 0.4 },
    odor_indicator: { interior_odor: 1.0 },
  },
};

export const RUBRICS: Record<string, Rubric> = {
  clothing: CLOTHING,
  sports_cards: SPORTS_CARDS,
  watches: WATCHES,
  shoes: SHOES,
};

/** Item categories that have a dedicated non-clothing rubric ready to activate. */
export const NON_CLOTHING_RUBRIC_KEYS = ["sports_cards", "watches", "shoes"] as const;

/** Resolves the rubric for an item_category / rubric_key; clothing is the default. */
export function rubricForKey(key: string | null | undefined): Rubric {
  if (!key) return CLOTHING;
  return RUBRICS[key] ?? CLOTHING;
}

// ---------------------------------------------------------------------------
// Rubric-driven weighted overall (US-1997, activation checklist step 2)
// ---------------------------------------------------------------------------
//
// The two live weighted-overall implementations — ai-grading.roundToTenth over
// FACTOR_WEIGHTS, and human-review.computeWeightedOverall — are both hard-typed
// to the five CLOTHING factors, in two different key spaces (AI response names
// vs. grade_reports column names). Neither can score a rubric with a different
// factor set, so nothing downstream of this registry could compute an overall
// for a card, a watch or a pair of shoes.
//
// This is the generalized form: same arithmetic, same 0.1 rounding, same
// refusal, but the factor set comes from the rubric instead of a hardcoded
// union. For CLOTHING it is byte-identical to both existing implementations —
// that is not an assertion of intent, it is asserted directly, by running the
// existing shared fixture (src/test/fixtures/weighted-grade-cases.json, the
// US-2034/US-2386 table the other two mirrors are already pinned by) through
// this function under the clothing rubric. See rubric-parity_test.ts.
//
// It is deliberately NOT wired into the pipeline yet: activating non-clothing
// grading needs new per-category composite prompts, and a new prompt reaches
// live traffic only through shadow-compare → golden-set eval gate → canary
// (see the grading-engine contract). The non-clothing golden set does not exist
// yet and cannot be fabricated — golden cases grow from real human-corrected
// grades. So this lands the scoring math, pinned, ahead of that gate.
//
// NO CLAMP, on purpose. ai-grading clamps the weighted sum to 1.0–10.0 before
// rounding; human-review does not. Under the invariant both rely on — every
// factor validated to 1.0–10.0, rubric weights summing to 1.0 — the clamp is a
// no-op, so the two agree today. Clamping HERE would not be a no-op if that
// invariant ever broke: it would quietly launder an out-of-range factor into a
// plausible grade, which is the same failure mode US-2386 removed when it
// replaced `?? 0` with a refusal. An impossible input should announce itself.

/**
 * A rubric's weights must sum to 1.0. Floating-point exact equality is the
 * wrong test for that, so callers and suites compare within this tolerance.
 */
export const RUBRIC_WEIGHT_SUM_TOLERANCE = 1e-9;

/** Sum of a rubric's factor weights. Should be 1.0 for every rubric. */
export function rubricWeightSum(rubric: Rubric): number {
  return rubric.factors.reduce((total, factor) => total + factor.weight, 0);
}

// Mirrors requireFactor in human-review.ts / src/lib/weighted-grade.ts — a
// missing or non-finite factor REFUSES rather than scoring itself as 0 or
// falling out as NaN. The message names the rubric as well as the factor,
// because with a variable factor set "corners is missing" is ambiguous about
// which rubric was expected. src/lib/rubrics.ts produces the SAME string.
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
 * grade_reports.factor_scores (00231) stores for a non-clothing report.
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
