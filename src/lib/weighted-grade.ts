// US-2034 — the ONE client-side weighted-overall calculation.
//
// WHY THIS FILE EXISTS. This formula had four independent copies: three admin
// UIs (reviews, grading, disputes) and the edge (`human-review.ts`). They are
// supposed to agree exactly — the number an operator sees while adjusting
// factor scores must be the number the server persists to the certificate.
//
// They did not agree. `admin/disputes.tsx` rounded to the nearest 0.5 while
// every other site rounded to 0.1, so on a dispute an operator saw a projected
// overall up to 0.2 away from what was actually stored — in BOTH directions
// (8.5 shown vs 8.3 stored; 8.5 shown vs 8.7 stored). Grade tier is a pricing
// input, so that drift is money, and the resealed certificate hash makes the
// wrong number look authoritative.
//
// This is the SECOND time this exact drift shipped. US-1557 caught
// `admin/grading.tsx` rounding to 0.5 on 2026-07-03 and fixed it — but the fix
// was applied site-by-site and missed `disputes.tsx`, which is precisely the
// failure mode of keeping N copies instead of one. Hence: one copy for the web.
//
// ⚠ The edge keeps its own implementation (`services/edge-functions/src/lib/
// human-review.ts`) because the two projects cannot import across each other.
// That mirror is legitimate and unavoidable — which is exactly why it is pinned
// by a SHARED BEHAVIOURAL FIXTURE (src/test/fixtures/weighted-grade-cases.json)
// asserted by BOTH suites, rather than by a comment asking people to remember.

import { GRADE_FACTORS } from "@/lib/constants";

/**
 * Factor scores keyed by their DATABASE column names (`*_score`), which is the
 * shape every admin surface and `grade_reports` already uses.
 */
export interface WeightedFactorScores {
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
}

/** Column name → its weight, derived from the single GRADE_FACTORS source. */
export const WEIGHTED_FACTOR_WEIGHTS: Record<keyof WeightedFactorScores, number> = {
  fabric_condition_score: GRADE_FACTORS.fabric_condition.weight,
  structural_integrity_score: GRADE_FACTORS.structural_integrity.weight,
  cosmetic_appearance_score: GRADE_FACTORS.cosmetic_appearance.weight,
  functional_elements_score: GRADE_FACTORS.functional_elements.weight,
  odor_cleanliness_score: GRADE_FACTORS.odor_cleanliness.weight,
};

export const WEIGHTED_FACTOR_KEYS = Object.keys(
  WEIGHTED_FACTOR_WEIGHTS,
) as (keyof WeightedFactorScores)[];

/**
 * The weighted overall, rounded to ONE DECIMAL PLACE.
 *
 * Rounding to 0.1 — not 0.5 — is the contract. Factor scores move in 0.5 steps,
 * but the weighted result does not: a 30/25/20/15/10 blend of half-steps lands
 * on tenths, and forcing it to halves both discards real signal and disagrees
 * with the value the server stores.
 */
export function computeWeightedOverall(factors: WeightedFactorScores): number {
  let total = 0;
  for (const key of WEIGHTED_FACTOR_KEYS) {
    total += (factors[key] ?? 0) * WEIGHTED_FACTOR_WEIGHTS[key];
  }
  return Math.round(total * 10) / 10;
}
