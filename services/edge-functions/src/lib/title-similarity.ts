// US-2677: catching a seller competing against themselves.
//
// THE FAILURE THIS PREVENTS is not eBay deleting a listing. It is a thrift
// seller who lists nine similar tees, writes nine near-identical titles because
// the AI wrote all nine from the same template, and then finds the whole set
// buried. eBay's duplicate-listings policy exists to stop search results filling
// with one seller, and the enforcement lands on the STORE, not on the offending
// listing -- so the seller sees a slow store and no error message anywhere.
//
// Which is why this is a WARNING and never a blocker. Two genuinely different
// garments can legitimately carry similar titles, the seller is the only one who
// can tell, and refusing to publish would break the exact workflow FlipDesk is
// for: listing a lot of similar second-hand clothing quickly.
//
// Pure. No I/O, no clock. The caller does the scoping (US-268) and the fetching.

import { supabaseAdmin } from "./supabase.ts";

/**
 * Jaccard overlap at or above which two titles are called near-duplicates.
 *
 * Jaccard (shared tokens over total distinct tokens) rather than the overlap
 * coefficient, which divides by the SHORTER title and therefore scores any
 * short title fully contained in a longer one as a perfect 1.0 -- "Nike Tee"
 * inside "Nike Tee Vintage Single Stitch Large Blue" is not a duplicate, it is
 * a less descriptive title.
 *
 * 0.5, and the number is measured from the two real shapes rather than picked.
 * Both are in the test file so a future reader can re-judge it:
 *
 *   • template-written, differing only in SIZE        -> 0.78
 *   • template-written, differing in COLOUR AND SIZE  -> 0.56
 *   • a short title fully contained in a longer one   -> 0.36
 *   • two real garments sharing only the brand        -> 0.07
 *
 * The first two are the failure; the last two are not. 0.5 is the only value
 * that separates them, and the gap either side of it is wide, which is why one
 * global threshold works here at all.
 *
 * It started at 0.6 and that was wrong: it caught the size-only pair and missed
 * the colour-and-size pair, which is the SAME nine tees from one template and
 * exactly as cannibalising.
 */
export const DUPLICATE_TITLE_OVERLAP = 0.5;

/**
 * Titles shorter than this are not compared.
 *
 * Overlap between two-token titles is quantised into steps so coarse that the
 * number stops meaning anything: two titles sharing one token out of two score
 * 0.33, and sharing both score 1.0, with nothing in between. A title that short
 * has its own problem, and the title meter already says so.
 */
export const MIN_TITLE_TOKENS = 4;

/**
 * Tokens carried by nearly every clothing title, which therefore say nothing
 * about whether two listings are the same thing.
 *
 * Deliberately much smaller than the demand-term stopword list. That one strips
 * words with no SEARCH value; this one strips words with no DISTINGUISHING
 * value, and the two are different questions -- "vintage" is a real search term
 * and a useless discriminator, because half a thrift seller's inventory is
 * vintage.
 */
const NON_DISTINGUISHING = new Set<string>([
  "the", "and", "for", "with", "a", "an", "of", "to", "in", "on", "by",
  "new", "used", "size", "mens", "womens", "men", "women", "kids", "unisex",
  "nwt", "nwot", "euc", "vguc", "guc", "preowned", "owned", "pre",
  "vintage", "rare", "authentic", "genuine", "official",
  "free", "shipping", "fast", "lot", "excellent", "good", "great", "nice",
]);

function tokenize(title: string): string[] {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1);
}

/** Distinct, distinguishing tokens of a title, in first-seen order. */
export function distinctiveTokens(title: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(title)) {
    if (NON_DISTINGUISHING.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Jaccard overlap of two titles' distinguishing tokens, 0..1.
 *
 * Returns 0 rather than throwing for empty or too-short input, so a caller
 * cannot accidentally warn about a title that was never compared.
 */
export function titleOverlap(a: string, b: string): number {
  const ta = new Set(distinctiveTokens(a));
  const tb = new Set(distinctiveTokens(b));
  if (ta.size < MIN_TITLE_TOKENS || tb.size < MIN_TITLE_TOKENS) return 0;

  let shared = 0;
  for (const token of ta) {
    if (tb.has(token)) shared++;
  }
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** One of the seller's other live listings, as the check needs to see it. */
export interface ComparableListing {
  listingId: string;
  title: string;
  /** Leaf category. The caller filters on it; this is here for the message. */
  categoryId?: string | null;
}

export interface DuplicateTitleFinding {
  /** The listing the candidate looks like. */
  listingId: string;
  title: string;
  /** 0..1, at or above DUPLICATE_TITLE_OVERLAP. */
  overlap: number;
  /** Tokens both titles carry. What makes them look alike. */
  sharedTokens: string[];
  /**
   * Tokens the CONFLICTING listing has and the candidate does not.
   *
   * This is what a regenerate-to-differentiate action needs: it is the wording
   * already spoken for, and the new title should avoid leaning on it.
   */
  conflictOnlyTokens: string[];
}

export interface FindDuplicateOptions {
  threshold?: number;
  /** Cap on findings returned, worst first. Default 3. */
  max?: number;
}

/**
 * Which of the seller's other live listings the candidate title looks like.
 *
 * Ranked worst-first, because a seller shown one conflict fixes one conflict --
 * the closest match is the one most worth showing. Returns an empty array when
 * there is nothing to compare against, which AC5 makes explicit: no other
 * listing in the category means no warning, not a warning with no partner.
 */
export function findDuplicateTitles(
  candidate: string,
  others: ComparableListing[],
  opts: FindDuplicateOptions = {},
): DuplicateTitleFinding[] {
  const threshold = opts.threshold ?? DUPLICATE_TITLE_OVERLAP;
  const max = opts.max ?? 3;
  const candidateTokens = new Set(distinctiveTokens(candidate));
  if (candidateTokens.size < MIN_TITLE_TOKENS) return [];

  const findings: DuplicateTitleFinding[] = [];
  for (const other of others ?? []) {
    const overlap = titleOverlap(candidate, other.title);
    if (overlap < threshold) continue;

    const otherTokens = distinctiveTokens(other.title);
    findings.push({
      listingId: other.listingId,
      title: other.title,
      overlap,
      sharedTokens: otherTokens.filter((t) => candidateTokens.has(t)),
      conflictOnlyTokens: otherTokens.filter((t) => !candidateTokens.has(t)),
    });
  }

  findings.sort((a, b) =>
    b.overlap - a.overlap ||
    (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0)
  );
  return findings.slice(0, Math.max(0, max));
}

/** Human-readable warning line, in the shape the validate route already emits. */
export function duplicateTitleWarning(finding: DuplicateTitleFinding): string {
  const pct = Math.round(finding.overlap * 100);
  return `This title is ${pct}% the same as your live listing "${finding.title}". ` +
    `eBay can demote a whole store for near-duplicate listings, so reword one of them.`;
}

// ---------------------------------------------------------------------------
// AC6: the batch, checked against ITSELF
// ---------------------------------------------------------------------------

export interface DraftTitle {
  /** Whatever the caller keys drafts by: an item id, a listing id, an index. */
  id: string;
  title: string;
}

export interface DuplicatePair {
  a: string;
  b: string;
  overlap: number;
}

/**
 * Near-duplicate pairs WITHIN one generated batch.
 *
 * The per-listing check cannot see this. Nine tees generated together are nine
 * drafts, none of them live yet, so every one of them compares against an empty
 * set of active listings and passes. They only become each other's duplicates
 * after publish, which is exactly too late -- the seller has already approved
 * nine titles one at a time.
 *
 * Each pair is reported ONCE, in id order, rather than twice from both sides:
 * a batch of nine identical titles has 36 pairs, and reporting 72 of them is a
 * wall of text that hides the fact that there are only nine things to fix.
 */
export function findDuplicatesWithinBatch(
  drafts: DraftTitle[],
  opts: FindDuplicateOptions = {},
): DuplicatePair[] {
  const threshold = opts.threshold ?? DUPLICATE_TITLE_OVERLAP;
  const rows = (drafts ?? []).filter((d) => d && typeof d.title === "string");
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const overlap = titleOverlap(rows[i]!.title, rows[j]!.title);
      if (overlap < threshold) continue;
      const [a, b] = rows[i]!.id <= rows[j]!.id
        ? [rows[i]!.id, rows[j]!.id]
        : [rows[j]!.id, rows[i]!.id];
      pairs.push({ a, b, overlap });
    }
  }

  pairs.sort((x, y) =>
    y.overlap - x.overlap ||
    (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) ||
    (x.b < y.b ? -1 : x.b > y.b ? 1 : 0)
  );
  return pairs;
}

// ---------------------------------------------------------------------------
// The fetch. Everything above is pure; this is the part US-268 is about.
// ---------------------------------------------------------------------------

/**
 * The seller's OTHER live listings in the same leaf category.
 *
 * TENANT SCOPING (US-268). The edge runs on the service-role client, which
 * bypasses RLS, so the filter on the resolved owner id is the only thing
 * separating tenants. The caller passes workspaceOwnerId ?? userId, because a
 * workspace member acting in someone's workspace must compare against the
 * OWNER's listings, not their own.
 *
 * The category filter is not just a narrowing. eBay's duplicate policy is about
 * competing in the SAME search results, and two listings in different leaf
 * categories do not. Comparing across categories would warn a seller about a
 * jacket that reads like their tee, which is noise they would learn to dismiss
 * -- and a warning people dismiss is worse than no warning.
 *
 * Excludes the candidate's own listing row, which would otherwise score a
 * perfect 1.0 against itself on every single edit.
 */
export async function fetchComparableListings(
  ownerId: string,
  categoryId: string | null | undefined,
  excludeListingId?: string | null,
): Promise<ComparableListing[]> {
  // AC5 falls out of here rather than being a special case: no category means
  // nothing defensible to compare against, so nothing is compared.
  if (!categoryId) return [];

  let query = supabaseAdmin
    .from("listings")
    .select("id, listing_title, platform_category_id")
    .eq("user_id", ownerId)
    .eq("platform_category_id", categoryId)
    .eq("listing_status", "active")
    .limit(200);
  if (excludeListingId) query = query.neq("id", excludeListingId);

  const { data, error } = await query;
  if (error) {
    // A duplicate warning is a courtesy. It must never be the reason a seller
    // cannot see whether their listing is publishable.
    console.error("[title-similarity] comparable lookup failed:", error.message);
    return [];
  }

  return ((data ?? []) as Array<{
    id: string;
    listing_title: string | null;
    platform_category_id: string | null;
  }>)
    .filter((r) => (r.listing_title ?? "").trim().length > 0)
    .map((r) => ({
      listingId: r.id,
      title: r.listing_title!,
      categoryId: r.platform_category_id,
    }));
}

/**
 * Fetch, compare, and render the warning lines the validate route emits.
 *
 * Returns strings because that is what PublishContext.warnings holds, and a
 * second warning shape there would mean every consumer has to learn both.
 */
export async function duplicateTitleWarningsFor(
  ownerId: string,
  candidateTitle: string,
  categoryId: string | null | undefined,
  excludeListingId?: string | null,
): Promise<string[]> {
  if (!candidateTitle.trim()) return [];
  const others = await fetchComparableListings(ownerId, categoryId, excludeListingId);
  return findDuplicateTitles(candidateTitle, others).map(duplicateTitleWarning);
}
