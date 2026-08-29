// Builds eBay sold-listing search URLs (US-9021).
//
// WHY A URL BUILDER AND NOT A COMP API. The obvious version of this tool calls
// eBay and prints sold prices. GradeThread cannot do that and must not pretend
// to: EBAY_MARKETPLACE_INSIGHTS has never been granted, so the only comp data
// the platform can reach is ACTIVE asking prices. Printing those under the word
// "sold" is precisely the defect services/edge-functions/src/lib/value-disclosure.ts
// exists to prevent, and it would be a worse answer than the one below.
//
// So this hands the visitor eBay's own sold results, which are real, free, and
// exactly what they typed the query looking for. Everything here is a pure
// string function: nothing is fetched, nothing is sent, and an anonymous
// visitor leaves no trace.
//
// THE RUNGS ARE THE PRODUCT'S OWN LADDER. A single search is not a comp set —
// too narrow returns three results, too broad returns a different garment. The
// rungs below mirror comps-ladder.ts in the edge service (exact -> broadened ->
// brand_category), so the page teaches the same method the grading pipeline
// uses rather than a second opinion invented for a marketing page.
//
// PARAMETERS VERIFIED AGAINST LIVE EBAY on 2026-08-28, not recalled: a search
// for "patagonia synchilla fleece" under _sacat=11450 returned 4,900+ sold
// results with LH_ItemCondition unset, 210 at 1000, and 54 at 1500. Sold
// searches already sort by Ended Recently, so no _sop is sent.

/** eBay's "Clothing, Shoes & Accessories" category. */
export const EBAY_CSA_CATEGORY = "11450";

const EBAY_SEARCH_BASE = "https://www.ebay.com/sch/i.html";

/**
 * eBay condition ids for clothing, with the label eBay itself shows on the
 * results. Only ids confirmed against live results are offered; guessing one
 * would send a visitor to an empty page and blame their search terms.
 */
export const EBAY_CONDITIONS = [
  { id: "", label: "Any condition" },
  { id: "3000", label: "Pre-owned" },
  { id: "1000", label: "New with tags" },
  { id: "1500", label: "New without tags" },
] as const;

export type EbayConditionId = (typeof EBAY_CONDITIONS)[number]["id"];

export interface SoldSearchInput {
  brand: string;
  item: string;
  size: string;
  conditionId: EbayConditionId;
}

/** How broad a rung is, mirroring CompBreadth in the edge comps ladder. */
export type SoldSearchRung = "exact" | "broadened" | "brand_category";

export interface SoldSearch {
  rung: SoldSearchRung;
  /** Heading on the result card. */
  label: string;
  /** Why a seller would open this one rather than the one above it. */
  why: string;
  /** The keywords this rung searches, already collapsed. */
  keywords: string;
  url: string;
}

/** Collapse whitespace and drop the punctuation eBay treats as noise. */
export function normalizeTerms(...parts: string[]): string {
  return parts
    .join(" ")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function buildSoldSearchUrl(
  keywords: string,
  conditionId: EbayConditionId = "",
): string {
  const params = new URLSearchParams();
  params.set("_nkw", keywords);
  // Both are needed. LH_Complete alone returns unsold endings too, which is a
  // different and much less useful question.
  params.set("LH_Sold", "1");
  params.set("LH_Complete", "1");
  params.set("_sacat", EBAY_CSA_CATEGORY);
  if (conditionId) params.set("LH_ItemCondition", conditionId);
  return `${EBAY_SEARCH_BASE}?${params.toString()}`;
}

/**
 * The rungs worth opening for one item, narrowest first.
 *
 * Rungs that would duplicate the one above are dropped rather than rendered as
 * a second identical link: with no size entered, "exact" and "broadened" ask
 * the same question, and showing both would imply the seller had checked two
 * things when they had checked one.
 */
export function buildSoldSearches(input: SoldSearchInput): SoldSearch[] {
  const brand = normalizeTerms(input.brand);
  const item = normalizeTerms(input.item);
  const size = normalizeTerms(input.size);
  if (!brand && !item) return [];

  const searches: SoldSearch[] = [];
  const push = (
    rung: SoldSearchRung,
    label: string,
    why: string,
    keywords: string,
  ) => {
    if (!keywords) return;
    if (searches.some((s) => s.keywords === keywords)) return;
    searches.push({
      rung,
      label,
      why,
      keywords,
      url: buildSoldSearchUrl(keywords, input.conditionId),
    });
  };

  push(
    "exact",
    "Exact match",
    "Closest to your garment. Start here, but treat it as a comp set only if it returns more than about five results.",
    normalizeTerms(brand, item, size),
  );
  push(
    "broadened",
    "Same item, any size",
    "Size splits a small comp set into nothing. Prices move less across sizes than sellers expect, so this is usually the honest median.",
    normalizeTerms(brand, item),
  );
  push(
    "brand_category",
    "Brand only",
    "The sanity check. If the brand median sits far from your item's, one of the two searches caught the wrong garment.",
    brand,
  );

  return searches;
}
