// US-3535: a factor no photo could judge must not quietly cost the seller.
//
// The per-image prompt already marks, per photo, the factors it could not
// judge (unassessable_factors), and the composite prompt says: if NO image
// could assess a factor, write a neutral 7.0. The composite parser then treats
// that 7.0 as a real reading. On a pristine tee with no zipper or buttons in
// any photo, functional_elements lands at 7.0 and, at 15% weight, pulls a 10
// garment down to NWOT with nobody looking.
//
// This finds those factors from the per-image output, deterministically, so
// the grade can go to a person instead of shipping the placeholder. Forced
// review rather than reweighting: reweighting would change the weighted
// overall, which three code paths compute in lockstep and a human correction
// recomputes with the fixed weights.
//
// odor_cleanliness is left out. No photo can smell, so it is unassessable on
// almost every grade; it already has its own honest handling on the
// certificate (cleanliness-visibility.ts, US-3329), and including it would
// send every grade to review.
//
// Shipped inert behind GRADING_UNASSESSED_FACTOR_REVIEW (default off). With the
// flag off nothing reads this, so grading is byte-identical. It changes no
// prompt text, so there is no prompt_version suffix; it changes which grades
// a person checks, and the operator should expect more reviews for garments
// that have no functional elements at all (tees, most knits).

// The per-image keys (no _score suffix), as unassessable_factors carries them.
const FACTOR_KEYS = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
] as const;

/** The confidence ceiling when a weighted factor was never observed. */
export const UNASSESSED_FACTOR_CONFIDENCE_CAP = 0.6;

const EXCLUDED = new Set(["odor_cleanliness"]);

export function unassessedFactorReviewEnabled(): boolean {
  const raw = (Deno.env.get("GRADING_UNASSESSED_FACTOR_REVIEW") ?? "").trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * Factors that EVERY analyzed photo listed as unassessable. No analyses, or a
 * shape this does not recognise, answers [] (nothing claimed).
 */
export function unassessedFactors(
  analyses: ReadonlyArray<{ unassessable_factors?: unknown } | null>,
): string[] {
  if (analyses.length === 0) return [];
  return FACTOR_KEYS.filter((key) =>
    !EXCLUDED.has(key) &&
    analyses.every((a) => {
      const u = a?.unassessable_factors;
      return Array.isArray(u) && u.includes(key);
    })
  );
}
