// US-1716: brand knowledge seeding — provenance enforcement.
//
// Every fact seeded into the brand knowledge base (US-1710 tables) MUST carry a
// source and a calibrated confidence — an unsourced "fact" is a guess wearing a
// citation's clothes, and the whole point of the KB is to be MORE trustworthy
// than the model's memory, not to launder guesses into the prompt. This module
// is the gate: the AI-assisted drafting job (US-1718+), the admin verify UI
// (US-1715), and every brand-content seed run rows through validateBrandFact /
// partitionSeedFacts so an unsourced or mis-scored fact is REJECTED, not stored.
//
// Pure (no DB / network) so it unit-tests directly and can run anywhere.

/** The provenance every seeded row must carry (mirrors the 00389 columns). */
export interface BrandFactProvenance {
  source_url?: string | null;
  confidence?: number | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate one fact's provenance. A fact is acceptable only when it cites a
 * non-blank source and a calibrated confidence in [0, 1]. `verified` rows (a
 * human confirmed it in the admin UI) may carry confidence 1.0; unverified
 * AI-drafted rows should score their real uncertainty.
 */
export function validateBrandFact(fact: BrandFactProvenance): ValidationResult {
  const errors: string[] = [];
  if (!fact.source_url || String(fact.source_url).trim() === "") {
    errors.push("missing source_url");
  }
  const c = fact.confidence;
  if (c == null || typeof c !== "number" || Number.isNaN(c)) {
    errors.push("missing confidence");
  } else if (c < 0 || c > 1) {
    errors.push(`confidence ${c} out of range [0,1]`);
  }
  return { ok: errors.length === 0, errors };
}

export interface PartitionResult<T> {
  accepted: T[];
  rejected: Array<{ fact: T; errors: string[] }>;
}

/**
 * Split a batch of proposed facts into the ones safe to seed (well-sourced) and
 * the ones that must be rejected. The drafting job seeds only `accepted` and
 * surfaces `rejected` for a human to source or drop — nothing unsourced ever
 * reaches the tables.
 */
export function partitionSeedFacts<T extends BrandFactProvenance>(
  facts: T[],
): PartitionResult<T> {
  const accepted: T[] = [];
  const rejected: Array<{ fact: T; errors: string[] }> = [];
  for (const fact of facts) {
    const v = validateBrandFact(fact);
    if (v.ok) accepted.push(fact);
    else rejected.push({ fact, errors: v.errors });
  }
  return { accepted, rejected };
}
