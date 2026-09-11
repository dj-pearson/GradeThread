// US-3346: one place that decides how the unfilled-recommended-specifics list
// is worded, because three surfaces were each describing it differently and all
// three were describing it wrongly.
//
// THE CLAIM THAT WAS WRONG. recommendedAspectCoverage() on the edge sorts the
// unfilled names by `relevanceIndicator.searchCount`, eBay's 30-day buyer-search
// volume for that aspect in that category, and the UI told sellers so: "eBay's
// most-searched, in order". Measured 2026-09-11 on the raw response bytes of a
// full census (scripts/aspect-demand-cut.mjs, 457 leaf categories under 11450 on
// EBAY_US, 8,748 aspect rows, 98.8 MB of response body): eBay sends that field
// on ZERO of them. Every rank ties at zero, so the sort falls through to its
// final tie-break and the list a seller reads is ALPHABETICAL.
//
// A seller working the list top-down believed they were working the
// highest-impact fields first. They were working the alphabet.
//
// WHY THE TRUNCATION MATTERED MORE THAN THE SENTENCE. Every surface showed the
// first six or eight names and stopped. A prefix of a ranked list is the top of
// it; a prefix of an alphabetical list is the letters A to C, forever, and the
// same three aspects lead every garment in the catalog. So the count of what is
// hidden ships alongside the names now: "and 7 more" is the difference between
// a shortlist and a truncation.
//
// NO ORDERING IS CLAIMED HERE ON PURPOSE. Choosing a real one is a product
// decision with real options (see the story), and inventing a rank the data
// cannot support is what this module exists to undo. If eBay ever starts
// publishing demand on this tree, src/test/aspect-demand-absent.test.ts goes
// red and this copy should go back to naming it.

/**
 * How the list is actually ordered, in words a seller can check.
 *
 * Deliberately not "by relevance" or "by impact": both imply a judgement
 * nothing computes.
 */
export const MISSING_SPECIFICS_ORDER_LABEL = "A to Z";

/**
 * Why it is ordered that way, for a tooltip or a title attribute.
 *
 * AC3's rule in one sentence: name the source rather than implying one.
 */
export const MISSING_SPECIFICS_ORDER_NOTE =
  "eBay does not tell us which of these buyers look for most, so they are listed A to Z.";

export interface MissingSpecificsSummary {
  /** The names to render, at most `limit` of them. */
  shown: string[];
  /** How many names were left out. Zero when the whole list fits. */
  moreCount: number;
  /** The names and the remainder as one plain string, for a title attribute. */
  text: string;
}

/**
 * Split the unfilled-specifics list into what to show and what to count.
 *
 * `limit` below 1 shows nothing and counts everything, which is what a caller
 * with no room should get rather than a thrown error. Blank and duplicate names
 * are dropped: the edge builds the list from eBay's aspect names, and a blank
 * chip is worse than a missing one.
 */
export function summariseMissingSpecifics(
  missing: readonly string[],
  limit: number,
): MissingSpecificsSummary {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of missing) {
    const name = (raw ?? "").trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  const room = Math.max(0, Math.floor(limit));
  const shown = names.slice(0, room);
  const moreCount = names.length - shown.length;
  const text =
    shown.length === 0
      ? moreCount > 0
        ? `${moreCount} unfilled`
        : ""
      : moreCount > 0
        ? `${shown.join(", ")} and ${moreCount} more`
        : shown.join(", ");
  return { shown, moreCount, text };
}
