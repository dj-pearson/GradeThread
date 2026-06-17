// Category-specific grading rubrics (server source of truth).
//
// Condition grading is currently clothing-only — see ai-grading.ts, whose
// FACTOR_WEIGHTS / FactorScores hardcode the 5 garment factors. This module
// defines the rubric PER item_category so the grading pipeline can, in the
// activation phase, select factors + weights + prompt guidance + defect routing
// by category instead of assuming clothing.
//
// FOUNDATION ONLY: this registry is NOT yet wired into the live pipeline, so
// clothing grading is byte-for-byte unchanged. The web mirror
// (src/lib/rubrics.ts) renders certificates from these definitions and MUST
// stay in sync (factor keys + weights + labels). The clothing weights here are
// identical to ai-grading.ts FACTOR_WEIGHTS.
//
// Activation checklist (follow-up):
//   1. Pass item_category into the grading pipeline (flipdesk-grading currently
//      maps it to garment_type; non-clothing has neither, and submissions
//      requires garment_type NOT NULL — de-gate that first).
//   2. Select the rubric by item_category; build the composite prompt from
//      rubric.factors + rubric.promptGuidance; compute the overall score from
//      these weights; route defects via rubric.defectRouting.
//   3. Persist grade_reports.factor_scores (JSONB) + rubric_key; recreate the
//      public_grade_reports view to expose them.

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
