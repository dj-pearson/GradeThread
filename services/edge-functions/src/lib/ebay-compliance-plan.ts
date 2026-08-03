/**
 * US-2329: what the compliance sync should WRITE, decided before it writes.
 *
 * THE BUG THIS REPLACES. The sync used to zero every flagged listing for the
 * owner in one update, then re-flag the violating ones row by row. Between those
 * two statements — and there is no transaction, so the window is real and lasts
 * as long as the re-flag loop — every listing with an open eBay policy violation
 * read as compliant. If the process died in that window, or if the re-flag
 * updates failed (their errors were counted away), the listings STAYED
 * compliant-looking with open violations, and nothing said so.
 *
 * The fix is to compute the whole plan first and never pass a still-violating
 * listing through zero. A listing that is violating now and was violating before
 * is written once, with its new counts; only listings that have genuinely become
 * clean are cleared, and they are cleared LAST.
 *
 * Pure on purpose: the ordering property is the fix, and a pure planner is the
 * only way to assert it without a database.
 */

/** A listing eBay currently reports violations for. */
export interface ComplianceTarget {
  platformListingId: string;
  count: number;
  /** Sorted, so two plans for the same state compare equal. */
  types: string[];
}

export interface CompliancePlan {
  /** Written first. Every current violator, with its fresh counts. */
  toFlag: ComplianceTarget[];
  /**
   * Written last, and only these. Listings that WERE flagged and are not in
   * eBay's current violation set — i.e. genuinely fixed.
   */
  toClear: string[];
}

/**
 * @param currentlyFlagged `platform_listing_id`s carrying a non-zero violation
 *   count in our DB right now.
 * @param violating what eBay reports open violations for, keyed by eBay listing
 *   id.
 */
export function planComplianceSync(
  currentlyFlagged: readonly (string | null)[],
  violating: ReadonlyMap<string, { count: number; types: Iterable<string> }>,
): CompliancePlan {
  const toFlag: ComplianceTarget[] = [];
  for (const [platformListingId, e] of violating) {
    toFlag.push({
      platformListingId,
      count: e.count,
      types: [...new Set(e.types)].sort(),
    });
  }
  // Stable order so a plan is reproducible and a test can compare it whole.
  toFlag.sort((a, b) => a.platformListingId.localeCompare(b.platformListingId));

  const seen = new Set<string>();
  const toClear: string[] = [];
  for (const id of currentlyFlagged) {
    // A flagged row with no platform_listing_id cannot be matched back to an
    // eBay violation at all, so it is left alone rather than cleared on a
    // comparison that could never have succeeded.
    if (!id) continue;
    if (violating.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    toClear.push(id);
  }
  toClear.sort();

  return { toFlag, toClear };
}
