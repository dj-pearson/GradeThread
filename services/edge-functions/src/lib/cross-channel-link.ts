// US-3197: is this listing on Poshmark the same physical garment as that one on eBay?
//
// WHY THIS EXISTS. Every import path in the repo dedupes on
// (platform, platform_listing_id) scoped to the owner — closet-import-run.ts,
// the CSV importer, the eBay feed sync. That makes re-importing the SAME
// channel idempotent, which is correct, and says nothing at all about two
// channels. So a seller who lists one jacket on eBay and Poshmark and then
// imports both ends up with TWO inventory_items rows for one hanger, two
// separate grades, two cost bases, and no delist when either one sells —
// because cross-listing-sale.ts plans a delist over rows sharing a
// listings.draft_id, and these do not share one.
//
// THE DECISION IS PURE AND LIVES HERE. The scoring, the refusals and the
// confidence bands are a function of two rows and nothing else: no DB, no
// network. The import worker consumes it. Keeping it separate is not tidiness —
// a wrong auto-link MERGES two garments, and an unmerge is not a button we
// have. This has to be unit-testable to the case, and it is.
//
// THREE BANDS, AND THE MIDDLE ONE IS THE POINT.
//   • "link"   — the same garment, confidently. Joined automatically.
//   • "review" — plausible. Held for the seller to confirm or split. NOTHING is
//                merged from this band. A reseller with six identical black
//                Hanes tees is the normal case, not the edge case.
//   • "none"   — not a match, or a HARD refusal (see below).
//
// A hard refusal is not a low score. Two rows whose brands both exist and
// differ, or whose sizes both exist and differ, are not the same garment no
// matter how alike their titles read, and no amount of title overlap may
// promote them. Scoring alone would happily merge "Nike Dri-FIT Tee M" with
// "Nike Dri-FIT Tee L".

/** One side of a comparison: an imported listing, or an item already held. */
export interface LinkCandidate {
  /** Marketplace the row came from. Two rows from the SAME platform never link. */
  platform: string;
  title: string;
  brand?: string | null;
  size?: string | null;
  color?: string | null;
  /** Major units. Compared as a ratio, never as an equality. */
  price?: number | null;
}

export type LinkVerdict = "link" | "review" | "none";

export interface LinkDecision {
  verdict: LinkVerdict;
  /** 0..1. Reported for every verdict, including refusals, so a review row can be ranked. */
  score: number;
  /** Why, in the order a human would check them. Always non-empty. */
  reasons: string[];
  /** Set when a hard rule refused the pair outright; score is then advisory only. */
  refusedBy: string | null;
}

/** At or above this, the pair is joined without asking. */
export const LINK_THRESHOLD = 0.82;
/**
 * The most a pair can score with neither brand nor size agreeing: a perfect
 * title (0.55), matching colour (0.05) and identical prices (0.08). Exported so
 * the tests can assert it stays below LINK_THRESHOLD — the invariant that keeps
 * "the titles matched" from ever being enough to merge two garments.
 */
export const MAX_UNANCHORED_SCORE = 0.55 + 0.05 + 0.08;
/** At or above this (and below LINK_THRESHOLD), the pair is held for review. */
export const REVIEW_THRESHOLD = 0.5;

// Words that carry no identity. Stripped before title comparison because they
// appear in most reseller titles and would inflate every pair's overlap toward
// each other — "NWT Womens Size M" against "NWT Womens Size M" is a 100% match
// on nothing at all.
const NOISE = new Set([
  "nwt", "nwot", "euc", "vguc", "guc", "new", "used", "preowned", "pre",
  "owned", "vintage", "rare", "size", "sz", "mens", "men", "womens", "women",
  "unisex", "adult", "kids", "youth", "the", "and", "with", "for", "a", "an",
  "in", "of", "free", "shipping", "fast", "excellent", "condition", "great",
  "good", "nice", "beautiful", "gorgeous", "htf", "euc",
]);

/** Lowercase, strip punctuation, drop noise words and pure numbers under 4 digits. */
export function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (title ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (NOISE.has(raw)) continue;
    // A bare 1-3 digit number is a size or a quantity far more often than an
    // identity. A style code (4+ digits) is the opposite and stays.
    if (/^\d{1,3}$/.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Jaccard overlap of the two token sets.
 *
 * Jaccard rather than a containment ratio on purpose: containment would score
 * "Nike Tee" inside "Nike Dri-FIT Vapor Golf Tee Navy Striped" as a perfect
 * match, and a two-word title matching everything is how a whole closet merges
 * into one row.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/** Case- and punctuation-insensitive, so "Free People" matches "free-people". */
function norm(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Sizes compare on their normalised form, so "M" matches "m" and "Medium"
 * matches "medium" — but "M" does NOT match "Medium", and that is deliberate.
 * Expanding abbreviations means a table of guesses per garment type (is "S"
 * small, or a shoe width?), and a wrong expansion here merges two garments.
 * Unequal-but-unexpanded reads as "cannot tell", which costs a review rather
 * than a merge.
 */
function sizesConflict(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === "" || nb === "") return false; // one side silent: not a conflict
  if (na === nb) return false;
  // One being a prefix of the other covers m/med/medium without a lookup table.
  return !(na.startsWith(nb) || nb.startsWith(na));
}

/** 1 when identical, falling to 0 as the prices diverge. Null on either side scores neutral. */
export function priceSimilarity(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null || b == null || a <= 0 || b <= 0) return 0.5;
  const ratio = Math.min(a, b) / Math.max(a, b);
  // Cross-posted prices differ ROUTINELY — sellers pad for Poshmark's fee — so
  // this has to be forgiving. Half the price is still the same jacket.
  return ratio;
}

/**
 * Decide whether two rows are the same physical garment.
 *
 * `a` is typically the newly imported listing and `b` an existing one, but the
 * function is symmetric and the tests assert that: a decision that depends on
 * argument order would make the result depend on import order.
 */
export function decideLink(a: LinkCandidate, b: LinkCandidate): LinkDecision {
  const reasons: string[] = [];

  // ── Hard refusals ────────────────────────────────────────────────────────
  //
  // Each of these ends the comparison. They are not weighted signals: a pair
  // that trips one is not the same garment, and letting a strong title score
  // outvote them is exactly how "Nike Tee M" merges with "Nike Tee L".

  if (a.platform === b.platform) {
    return {
      verdict: "none",
      score: 0,
      reasons: [`Both listings are on ${a.platform}.`],
      refusedBy: "same_platform",
    };
  }

  const brandA = norm(a.brand);
  const brandB = norm(b.brand);
  if (brandA !== "" && brandB !== "" && brandA !== brandB) {
    return {
      verdict: "none",
      score: 0,
      reasons: [`Different brands: ${a.brand} and ${b.brand}.`],
      refusedBy: "brand_conflict",
    };
  }

  if (sizesConflict(a.size, b.size)) {
    return {
      verdict: "none",
      score: 0,
      reasons: [`Different sizes: ${a.size} and ${b.size}.`],
      refusedBy: "size_conflict",
    };
  }

  // ── Weighted signals ─────────────────────────────────────────────────────
  //
  // Title carries the most because it is the only field that is always present
  // and always specific. Brand and size agreement are strong but cheap to
  // agree on by accident — half a closet is the same brand — so they confirm
  // rather than decide. Price is the weakest and is included only to separate
  // two same-brand same-size garments that a title cannot.

  const title = titleSimilarity(a.title, b.title);
  const brandAgrees = brandA !== "" && brandA === brandB;
  const sizeAgrees = norm(a.size) !== "" && norm(a.size) === norm(b.size);
  const colorAgrees = norm(a.color) !== "" && norm(a.color) === norm(b.color);
  const price = priceSimilarity(a.price, b.price);

  const score =
    title * 0.55 +
    (brandAgrees ? 0.18 : 0) +
    (sizeAgrees ? 0.14 : 0) +
    (colorAgrees ? 0.05 : 0) +
    price * 0.08;

  reasons.push(`Titles ${Math.round(title * 100)}% alike.`);
  if (brandAgrees) reasons.push(`Same brand (${a.brand}).`);
  if (sizeAgrees) reasons.push(`Same size (${a.size}).`);
  if (colorAgrees) reasons.push(`Same color (${a.color}).`);
  if (a.price != null && b.price != null) {
    reasons.push(`Priced ${a.price} and ${b.price}.`);
  }

  // ANCHORING IS A PRECONDITION FOR "link", NOT A TIEBREAK.
  //
  // A pair agreeing on nothing but its title is the state where a merge is most
  // likely to be wrong and least likely to be noticed: two bare titles reading
  // the same is the normal shape of a closet full of similar basics.
  //
  // As the weights stand this is also arithmetically unreachable — a perfect
  // title with matching colour and identical prices tops out at
  // 0.55 + 0.05 + 0.08 = 0.68, below LINK_THRESHOLD. That is not a reason to
  // delete the check. It is stated as a rule here so that raising the title
  // weight later cannot silently turn "the titles matched" into a merge, and
  // MAX_UNANCHORED_SCORE below is asserted in the tests so the arithmetic
  // cannot drift out from under the claim either.
  const anchored = brandAgrees || sizeAgrees;
  if (score >= LINK_THRESHOLD && !anchored) {
    reasons.push("Nothing but the title agrees, so this needs a look.");
    return { verdict: "review", score, reasons, refusedBy: null };
  }

  if (score >= LINK_THRESHOLD) return { verdict: "link", score, reasons, refusedBy: null };
  if (score >= REVIEW_THRESHOLD) return { verdict: "review", score, reasons, refusedBy: null };
  return { verdict: "none", score, reasons, refusedBy: null };
}

export interface RankedMatch extends LinkDecision {
  /** Index into the candidate list this decision is about. */
  index: number;
}

/**
 * Best match for one row against many, and the runners-up worth showing.
 *
 * AMBIGUITY DEMOTES. When the top two candidates score within `AMBIGUITY_GAP`
 * of each other, the winner drops from "link" to "review" however high it
 * scored — because a reseller with six identical black tees produces exactly
 * that shape, and picking the highest of six near-identical scores is picking
 * at random. This is the rule that keeps the bulk-seller case safe.
 */
export const AMBIGUITY_GAP = 0.06;

export function bestMatch(
  row: LinkCandidate,
  candidates: readonly LinkCandidate[],
): RankedMatch | null {
  const scored = candidates
    .map((c, index) => ({ ...decideLink(row, c), index }))
    .filter((d) => d.verdict !== "none")
    .sort((x, y) => y.score - x.score);

  const top = scored[0];
  if (!top) return null;

  const runnerUp = scored[1];
  if (top.verdict === "link" && runnerUp && top.score - runnerUp.score < AMBIGUITY_GAP) {
    return {
      ...top,
      verdict: "review",
      reasons: [
        ...top.reasons,
        `${scored.length} of your items look this similar, so pick the right one.`,
      ],
    };
  }
  return top;
}
