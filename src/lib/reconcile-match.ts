// Client-side fuzzy matcher for "link cluster to existing item" (US-285).
//
// The edge /suggest-item-match endpoint runs vision on a cluster's photos and
// returns brand + keyword hints (it never sees the user's item list). This pure
// function ranks the owner's photo-less candidate items against those hints so
// the most likely match can be surfaced first — never auto-applied.

export interface MatchHints {
  brand: string | null;
  keywords: string[];
}

export interface MatchCandidate {
  id: string;
  title: string;
  brand: string | null;
  sku: string | null;
}

export interface RankedMatch {
  id: string;
  /** 0..1 — confidence the candidate is the same item the photos show. */
  score: number;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
}

/**
 * Ranks candidates against vision hints. A brand hit is weighted heavily (it's
 * the strongest disambiguator); each matched keyword adds a smaller amount.
 * Returns matches with score > 0, highest first.
 */
export function rankItemMatches(
  hints: MatchHints,
  candidates: MatchCandidate[],
): RankedMatch[] {
  const brandTokens = hints.brand ? new Set(tokenize(hints.brand)) : new Set<string>();
  const keywordTokens = new Set(hints.keywords.flatMap((k) => tokenize(k)));
  // Nothing to match on → no suggestions (caller falls back to manual search).
  if (brandTokens.size === 0 && keywordTokens.size === 0) return [];

  const ranked: RankedMatch[] = [];
  for (const c of candidates) {
    const hay = new Set([
      ...tokenize(c.title),
      ...(c.brand ? tokenize(c.brand) : []),
      ...(c.sku ? tokenize(c.sku) : []),
    ]);

    let brandScore = 0;
    if (brandTokens.size > 0) {
      const hit = [...brandTokens].some((t) => hay.has(t));
      brandScore = hit ? 0.6 : 0;
    }

    let kwScore = 0;
    if (keywordTokens.size > 0) {
      const matched = [...keywordTokens].filter((t) => hay.has(t)).length;
      kwScore = (matched / keywordTokens.size) * 0.4;
    }

    const score = Math.min(1, brandScore + kwScore);
    if (score > 0) ranked.push({ id: c.id, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
