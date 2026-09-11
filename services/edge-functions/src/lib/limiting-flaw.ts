// US-3330: name the one flaw that keeps a grade from the next level.
//
// A seller sees 7.6 Very Good and the factor math, but not what stands between
// the item and Excellent. The defect weighting already knows: take each genuine
// flaw out in turn, re-run the same weighting, and see which removal lifts the
// grade into a higher tier.
//
// WHAT LEAVES THE SERVER is the flaw's own description (already public in
// defects_found), where it is, and the tier it is keeping the item from.
// NEVER a number: the per-defect penalty (BASE_WEIGHT in defect-weighting.ts)
// is deliberately unpublished, because a seller who knows the arithmetic
// photographs to minimise it. "Removing this adds 0.4" would publish it one
// flaw at a time. The type below has no numeric field, and a test says so.
//
// Pure: no supabase, no env.

import {
  applyDefectWeighting,
  type FactorScores,
  type WeightedDefect,
} from "./defect-weighting.ts";
import {
  clampScore,
  computeWeightedOverall,
  scoreToGradeTier,
} from "./human-review.ts";

/** What a certificate may say. Strings only, by design. */
export interface LimitingFlaw {
  defect: string;
  location: string;
  next_tier: string;
}

export interface FlawInput extends WeightedDefect {
  /** The model's own description of the flaw, e.g. "1 cm stain". */
  defect: string;
}

// The tiers a flaw can honestly be said to keep an item from. NWOT and NWT
// are about whether the item was ever worn, not how clean it is: removing a
// stain from a worn shirt does not make it "new without tags", so those two
// are never named.
const NAMEABLE_TIERS = ["Fair", "Good", "Very Good", "Excellent"] as const;
const TIER_ORDER = ["Poor", "Fair", "Good", "Very Good", "Excellent", "NWOT", "NWT"];

function overallFrom(model: FactorScores, defects: WeightedDefect[]): number {
  const b = applyDefectWeighting(model, defects).blendedFactors;
  return computeWeightedOverall({
    fabric_condition_score: clampScore(b.fabric_condition),
    structural_integrity_score: clampScore(b.structural_integrity),
    cosmetic_appearance_score: clampScore(b.cosmetic_appearance),
    functional_elements_score: clampScore(b.functional_elements),
    odor_cleanliness_score: clampScore(b.odor_cleanliness),
  });
}

/**
 * The single genuine flaw whose removal would lift the grade into a higher,
 * nameable tier, or null when there is none: no flaws, the model's own read
 * is what limits the score (removing a flaw lifts a ceiling nobody was at), or
 * the only tier reachable is one a flaw cannot honestly be said to block.
 *
 * `modelFactors` are the model's factor scores BEFORE the defect ceilings are
 * applied, exactly as compositeGrade passes them to applyDefectWeighting.
 */
export function findLimitingFlaw(
  modelFactors: FactorScores,
  flaws: readonly FlawInput[],
): LimitingFlaw | null {
  const genuine = flaws.filter((f) => !f.is_intentional);
  if (genuine.length === 0) return null;

  const current = overallFrom(modelFactors, genuine);
  const currentRank = TIER_ORDER.indexOf(scoreToGradeTier(current));

  let best: { flaw: FlawInput; overall: number } | null = null;
  genuine.forEach((flaw, i) => {
    const without = genuine.filter((_, j) => j !== i);
    const overall = overallFrom(modelFactors, without);
    if (!best || overall > best.overall) best = { flaw, overall };
  });
  if (!best) return null;
  const { flaw, overall } = best as { flaw: FlawInput; overall: number };

  // A jump past Excellent is still honestly "keeps this from Excellent"; it is
  // never "from NWOT" (see NAMEABLE_TIERS).
  const ceilingRank = TIER_ORDER.indexOf(NAMEABLE_TIERS[NAMEABLE_TIERS.length - 1]);
  const reachedRank = Math.min(TIER_ORDER.indexOf(scoreToGradeTier(overall)), ceilingRank);
  if (reachedRank <= currentRank) return null;
  const reached = TIER_ORDER[reachedRank];
  if (!(NAMEABLE_TIERS as readonly string[]).includes(reached)) return null;

  return {
    defect: flaw.defect.trim().slice(0, 160),
    location: (flaw.location ?? "").trim().slice(0, 80),
    next_tier: reached,
  };
}

/**
 * The public projection: the three string keys and nothing else, or null.
 * Mirrors the public_grade_reports.limiting_flaw column (00788) for the edge
 * certificate path, so a stray field in the stored JSON never reaches a buyer.
 */
export function publicLimitingFlaw(raw: unknown): LimitingFlaw | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.next_tier !== "string" || typeof r.defect !== "string") return null;
  return {
    defect: r.defect,
    location: typeof r.location === "string" ? r.location : "",
    next_tier: r.next_tier,
  };
}
