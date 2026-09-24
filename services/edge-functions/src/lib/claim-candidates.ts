// MP-09: which of a seller's listings an unmatched sale most likely was.
//
// Pure, so the ranking is testable without a database. Title similarity first
// (shared words over all words, the Jaccard index on lowercased tokens), then
// how close the listing price is to the sold price. A seller picks from the top
// of this list, so the order is the whole feature.

export interface ClaimCandidateRow {
  id: string;
  listing_title: string | null;
  listing_price: number | null;
  photo_url: string | null;
}

function tokens(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function rankClaimCandidates(
  reviewTitle: string | null,
  soldPriceCents: number | null,
  rows: ClaimCandidateRow[],
  limit = 50,
): ClaimCandidateRow[] {
  const priceGap = (r: ClaimCandidateRow): number => {
    if (soldPriceCents == null || r.listing_price == null) return Number.POSITIVE_INFINITY;
    return Math.abs(Math.round(Number(r.listing_price) * 100) - soldPriceCents);
  };
  return rows
    .map((r) => ({ r, sim: titleSimilarity(reviewTitle, r.listing_title), gap: priceGap(r) }))
    .sort((a, b) => b.sim - a.sim || a.gap - b.gap)
    .slice(0, limit)
    .map((x) => x.r);
}
