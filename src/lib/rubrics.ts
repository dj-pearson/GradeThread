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
