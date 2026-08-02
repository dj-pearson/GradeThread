// Human-review scoring + certificate-reseal helpers (US-775).
//
// When an admin adjusts a low-confidence AI grade, the certified grade fields
// change — so the certificate's tamper-evident integrity hash (cert-integrity.ts)
// MUST be recomputed server-side (only the edge holds CERT_SIGNING_KEY). The old
// admin UI mutated scores via the browser Supabase client and left content_hash
// stale, so an adjusted grade's public certificate would verify as 'mismatch'
// (tampered). These pure helpers centralize the weighting + reseal-field assembly
// so both the endpoint and its tests share one source of truth.

import { buildCertIntegrity, type CertIntegrity } from "./cert-integrity.ts";

export interface FactorScores {
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
}

// PRD grading weights (CLAUDE.md → Grading System). Sum = 1.0.
export const FACTOR_WEIGHTS: Record<keyof FactorScores, number> = {
  fabric_condition_score: 0.30,
  structural_integrity_score: 0.25,
  cosmetic_appearance_score: 0.20,
  functional_elements_score: 0.15,
  odor_cleanliness_score: 0.10,
};

export const FACTOR_KEYS = Object.keys(FACTOR_WEIGHTS) as (keyof FactorScores)[];

// US-2386: the refusal guard. Mirrors requireFactor in src/lib/weighted-grade.ts
// — keep the two in lockstep, including the message shape, so a reader hitting
// one in a log can find the other.
function requireFactor(f: FactorScores, key: keyof FactorScores): number {
  const value = f[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `computeWeightedOverall: factor "${key}" is missing or not finite ` +
        `(got ${String(value)}). Refusing to compute a weighted overall from ` +
        `an incomplete factor set.`,
    );
  }
  return value;
}

// Clamp a single factor to the 1.0–10.0 scale in 0.5 increments.
export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(10, Math.max(1, n)) * 2) / 2;
}

// Weighted overall, rounded to the nearest 0.1 (the 5 factors stay in 0.5 steps,
// but the aggregate is granular so a single-factor human correction actually
// moves the overall — e.g. 8.6 — instead of being swallowed by 0.5 rounding).
// Matches ai-grading.roundToTenth(weightedSum) and the admin reviews UI's
// computeWeightedScore.
//
// US-2386: a missing or non-finite factor REFUSES. This used to fall out as
// NaN while the web mirror (src/lib/weighted-grade.ts) coalesced the same input
// to 0 — two implementations that are supposed to agree byte-for-byte,
// disagreeing on the one input neither suite covered. Coalescing is the worse
// of the two: fabric alone is 30% of the blend, so scoring a missing factor 0
// turns a genuine 8.4 into a plausible ~5.4 that nothing flags, and the reseal
// below then certifies it with a tamper-evident hash. All five columns are NOT
// NULL on grade_reports (00001), so a missing key is a bug, not a data state.
// The refusal cases live in the shared fixture both suites assert.
export function computeWeightedOverall(f: FactorScores): number {
  let total = 0;
  for (const k of FACTOR_KEYS) total += requireFactor(f, k) * FACTOR_WEIGHTS[k];
  return Math.round(total * 10) / 10;
}

// Map a 1.0–10.0 score to its tier (mirrors ai-grading.scoreToGradeTier and
// admin-grading.scoreToTier).
export function scoreToGradeTier(score: number): string {
  if (score >= 10.0) return "NWT";
  if (score >= 9.0) return "NWOT";
  if (score >= 8.0) return "Excellent";
  if (score >= 7.0) return "Very Good";
  if (score >= 6.0) return "Good";
  if (score >= 5.0) return "Fair";
  return "Poor";
}

// The grade_reports fields that feed the certificate integrity hash and that the
// adjust path is allowed to change. ai_summary + buyer_writeup + coverage are NOT
// edited by a score adjustment, so they're carried through unchanged from the
// stored row (they still must be passed so the recomputed hash keeps matching the
// current canonical scheme — v3 seals the coverage scope, US-1279).
export interface ResealInput extends FactorScores {
  certificate_id: string;
  overall_score: number;
  grade_tier: string;
  ai_summary: string;
  buyer_writeup: string | null;
  // US-1279: the documented coverage scope, carried verbatim from the stored row
  // (a score adjustment never changes which zones the photos documented).
  coverage_pct?: number | null;
  covered_zones?: string[] | null;
  // US-2141: the coarse authenticity verdict, carried verbatim from the stored
  // row. A CONDITION adjustment must never silently rewrite an authenticity
  // verdict — if a reviewer disputes that, it goes through the authenticity
  // review path (US-2140), not through a grade reseal.
  authenticity_verdict?: string | null;
  authenticity_verdict_confidence?: number | null;
}

// Recompute the certificate integrity (hash + signature + version) for an
// adjusted grade. Thin wrapper over buildCertIntegrity so the endpoint reseals
// through the exact same canonicalizer the pipeline used at finalization.
export function resealCertificate(input: ResealInput): Promise<CertIntegrity> {
  return buildCertIntegrity({
    certificate_id: input.certificate_id,
    overall_score: input.overall_score,
    grade_tier: input.grade_tier,
    fabric_condition_score: input.fabric_condition_score,
    structural_integrity_score: input.structural_integrity_score,
    cosmetic_appearance_score: input.cosmetic_appearance_score,
    functional_elements_score: input.functional_elements_score,
    odor_cleanliness_score: input.odor_cleanliness_score,
    ai_summary: input.ai_summary,
    buyer_writeup: input.buyer_writeup,
    // US-1279: carry the unchanged coverage scope so the v3 hash keeps matching.
    coverage_pct: input.coverage_pct,
    covered_zones: input.covered_zones,
    // US-2141: likewise the authenticity verdict — unchanged by a score
    // adjustment, but it must be present or the reseal would drop it and the
    // v4 hash would stop matching what the certificate displays.
    authenticity_verdict: input.authenticity_verdict,
    authenticity_verdict_confidence: input.authenticity_verdict_confidence,
  });
}
