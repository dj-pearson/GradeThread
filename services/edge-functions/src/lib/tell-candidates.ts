// US-2147: turn what reviewers actually relied on into brand-knowledge candidates.
//
// US-2140 records `tells_relied_on` — the tell categories a human expert used to
// reach a verdict on a real item. That is the highest-value authenticity data the
// system generates, and until now it stopped at the golden set: a reviewer could
// identify the same decisive tell fifty times and the model would still not know
// it, because nothing routed it into brand_knowledge / CANONICAL_TELLS.
//
// This module aggregates those observations into RANKED CANDIDATES. It
// deliberately does not write anything:
//
//   Frequency is evidence, not authority.
//
// A tell entering the KB changes every future verdict for that brand, and the
// vault's brand rules (vault/20-domain/brands/) show how easily a plausible-
// looking pattern mints false positives. So a human promotes, through the
// existing admin curation surface with validateTellsForWrite — exactly as a
// seeded tell is reviewed today.

import type { AuthTellCategory } from "./brand-authenticity.ts";
import { isAuthTellCategory } from "./brand-authenticity.ts";

export interface ReviewTellObservation {
  brand_key: string;
  /** Tell categories the reviewer relied on for this outcome. */
  tells_relied_on: string[];
  /** The expert's verdict — decides which direction the tell is evidence FOR. */
  reviewer_verdict: string;
}

export interface TellCandidate {
  brand_key: string;
  category: AuthTellCategory;
  /** Times a reviewer relied on this category for this brand. */
  observations: number;
  /** …of which reached a 'counterfeit' verdict. */
  on_counterfeit: number;
  /** …of which reached an 'authentic' verdict. */
  on_authentic: number;
  /**
   * How one-directional the tell is (0..1). A category that only ever appears on
   * counterfeit findings is a red-flag candidate; one that appears on both about
   * equally is a thing reviewers LOOK AT, not a thing that DISCRIMINATES — and
   * seeding the latter as a tell adds noise to every future verdict.
   */
  discrimination: number;
  /** Which direction it points, when it points at all. */
  leans: "counterfeit" | "authentic" | "mixed";
}

/** Below this, a candidate is not worth an operator's attention yet. */
export const MIN_OBSERVATIONS = 3;
/** Below this, the category is used by reviewers but does not discriminate. */
export const MIN_DISCRIMINATION = 0.7;

/**
 * Rank tell candidates per brand from review observations. Pure + exported.
 *
 * Inconclusive outcomes are ignored entirely: a tell relied on to reach "I can't
 * tell" is evidence about neither direction, and counting it would dilute the
 * discrimination score of the categories that did decide something.
 */
export function rankTellCandidates(
  observations: readonly ReviewTellObservation[],
): TellCandidate[] {
  const byKey = new Map<string, TellCandidate>();

  for (const o of observations) {
    if (o.reviewer_verdict !== "counterfeit" && o.reviewer_verdict !== "authentic") continue;
    const brand = o.brand_key?.trim();
    if (!brand) continue;

    for (const raw of o.tells_relied_on ?? []) {
      if (!isAuthTellCategory(raw)) continue;
      const key = `${brand}::${raw}`;
      const c = byKey.get(key) ?? {
        brand_key: brand,
        category: raw,
        observations: 0,
        on_counterfeit: 0,
        on_authentic: 0,
        discrimination: 0,
        leans: "mixed" as const,
      };
      c.observations += 1;
      if (o.reviewer_verdict === "counterfeit") c.on_counterfeit += 1;
      else c.on_authentic += 1;
      byKey.set(key, c);
    }
  }

  const out = [...byKey.values()];
  for (const c of out) {
    const dominant = Math.max(c.on_counterfeit, c.on_authentic);
    c.discrimination = c.observations > 0
      ? Number((dominant / c.observations).toFixed(4))
      : 0;
    c.leans = c.discrimination < MIN_DISCRIMINATION
      ? "mixed"
      : c.on_counterfeit >= c.on_authentic
      ? "counterfeit"
      : "authentic";
  }

  // Most-supported first, then most-discriminating — an operator reviewing a
  // long list should meet the strongest candidates before their attention runs
  // out.
  out.sort((a, b) =>
    b.observations - a.observations ||
    b.discrimination - a.discrimination ||
    a.category.localeCompare(b.category)
  );
  return out;
}

/**
 * Is a candidate worth surfacing for promotion? Pure + exported.
 *
 * Both bars must clear. Enough observations that it is not one reviewer's habit,
 * AND enough directionality that it actually separates real from fake.
 */
export function isPromotable(c: TellCandidate): boolean {
  return c.observations >= MIN_OBSERVATIONS && c.discrimination >= MIN_DISCRIMINATION;
}

/**
 * Draft a tell for the operator to EDIT, not to accept as-is. Pure + exported.
 *
 * The claim/check text is intentionally a placeholder naming what still has to be
 * written by a human: we know reviewers keep relying on this category for this
 * brand, but the aggregate cannot say what a genuine example actually exhibits.
 * Auto-generating confident-sounding prose here would manufacture authority the
 * data does not contain.
 *
 * Confidence starts at the floor for the same reason — an aggregate is a reason
 * to LOOK, not a measure of how discriminating the eventual written tell is.
 */
export function draftTellFromCandidate(c: TellCandidate): {
  category: AuthTellCategory;
  claim: string;
  check: string;
  redFlag?: string;
  source: string;
  confidence: number;
} {
  return {
    category: c.category,
    claim: `TO WRITE — reviewers relied on ${c.category} for ${c.brand_key} in ` +
      `${c.observations} decided review(s). Describe what a GENUINE example exhibits.`,
    check: "TO WRITE — how to check this on the item in hand.",
    ...(c.leans === "counterfeit"
      ? { redFlag: "TO WRITE — the counterfeit signal reviewers were seeing." }
      : {}),
    source: `review-aggregate:${c.observations}obs/${c.discrimination}disc`,
    confidence: 0.5,
  };
}
