// US-2270: when to re-read an item's eBay category + item specifics after an AI
// extract.
//
// The extract used to resolve the eBay leaf category and fill its item-specifics
// INLINE and hand them back on the response as `ebay`. That second model call
// added ~20s, doubling the extract's latency, so the server moved it to a
// background task: it now returns `ebay: null` and `ebay_pending: true`, and
// persists `inventory_items.ebay_category_id` / `ebay_aspects` when it finishes.
//
// Both clients were still gated on `ebay` being non-null, so the branch that
// refreshes the specifics editor and tells the seller what happened became dead
// code. The category DID get resolved; it just looked like it hadn't, because the
// picker kept showing the values it seeded with and nothing said otherwise.
//
// This is the shared decision, kept pure so it can be tested without a query
// client or a timer.

/** How long the background category/aspects pass needs, with headroom. */
export const EBAY_PREP_FOLLOW_UP_MS = 25_000;

/** The `ebay`-related slice of an extract response this decision reads. */
export interface EbayPrepSignal {
  ebay?: { aspects?: Record<string, string[]> } | null;
  ebay_pending?: boolean;
}

export interface EbayPrepPlan {
  /** Re-read the item's saved category/aspects immediately. */
  refreshNow: boolean;
  /**
   * Re-read again after this many ms, once the background pass has had time to
   * land. null when there's nothing pending.
   */
  refreshAfterMs: number | null;
  /** What to tell the seller, or null to say nothing. */
  message: string | null;
  /** True while the category is still being resolved (drives a spinner/hint). */
  pending: boolean;
}

const NOTHING: EbayPrepPlan = {
  refreshNow: false,
  refreshAfterMs: null,
  message: null,
  pending: false,
};

/**
 * Decide how to reconcile an extract response with the item's eBay prep.
 *
 * Order matters: an inline `ebay` block means the work is ALREADY done (an older
 * edge build, or a future one that re-inlines it), so that wins over a pending
 * flag and needs no follow-up read.
 */
export function planEbayPrepRefresh(result: EbayPrepSignal): EbayPrepPlan {
  const inline = result.ebay;
  if (inline) {
    const filled = Object.values(inline.aspects ?? {}).filter(
      (v) => Array.isArray(v) && v.length > 0,
    ).length;
    return {
      refreshNow: true,
      refreshAfterMs: null,
      message:
        filled > 0
          ? `eBay category + ${filled} item specific${filled === 1 ? "" : "s"} filled from photos.`
          : "eBay category set from photos.",
      pending: false,
    };
  }

  if (result.ebay_pending) {
    return {
      // Refresh now as well: the pass can finish before the seller reads this,
      // and a stale picker is the whole complaint.
      refreshNow: true,
      refreshAfterMs: EBAY_PREP_FOLLOW_UP_MS,
      message:
        "Finding the eBay category and filling item specifics — they'll appear here in a moment.",
      pending: true,
    };
  }

  return NOTHING;
}
