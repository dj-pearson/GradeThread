// What eBay's answer about a listing actually MEANS (US-2656).
//
// The inbound sync used to decide this in one expression:
//
//     const isActive = (o.listingStatus ?? "").toUpperCase() === "ACTIVE";
//     listing_status: isActive ? "active" : "ended"
//
// Every way a listing can stop being ACTIVE collapsed into the same word. A
// seller who ended it, a listing eBay pulled for a policy issue, a garment that
// sold out, and an auction that closed with no bid all read as "ended", and the
// only explanation the app could offer was one hardcoded sentence that guessed
// three ways at once: "it may have ended, sold out, or been removed by eBay".
// eBay tells us which. We were throwing it away.
//
// Worse, OUT_OF_STOCK was read as ended. That is a LIVE listing under eBay's
// out-of-stock control — same item id, still occupying a slot, restockable — so
// calling it ended invited a relist that would mint a duplicate.
//
// This module is pure so the vocabulary is testable without eBay, and so the
// unknown-status path is a visible decision rather than an else-branch.

/** The local `listing_status` enum values this resolver can produce. */
export type LocalListingStatus = "active" | "ended";

/**
 * Why a listing is in the state it is. Recorded on the row so the seller is told
 * the actual reason instead of a disjunction of three.
 *
 * `unknown_status` is not a failure — it is how we LEARN eBay's real vocabulary.
 * eBay's published ListingStatus enum has been extended before, so an
 * unrecognised value is carried through verbatim (`ebayStatus`) rather than
 * silently folded into a neighbour, and shows up in the data as itself.
 */
export type ListingStateReason =
  | "active"
  | "out_of_stock"
  | "ended"
  | "inactive"
  | "completed"
  | "not_in_feed"
  | "unknown_status";

export interface EbayListingState {
  /** What to write to listings.listing_status. */
  status: LocalListingStatus;
  /** What to write to listings.is_active. */
  isActive: boolean;
  /** eBay's own word, upper-cased, or null when it sent none. */
  ebayStatus: string | null;
  reason: ListingStateReason;
  /**
   * Seller-facing sentence, or null when nothing needs explaining (the listing
   * is simply live). Written to listings.publish_error, which the Drafts badge
   * already renders.
   */
  message: string | null;
}

// eBay's ListingStatus vocabulary as we understand it today. Deliberately a map
// rather than a set of if-statements: adding a value eBay introduces is a
// one-line change here and nowhere else, and the test file reads the same map.
const KNOWN_STATUSES: Record<
  string,
  { status: LocalListingStatus; isActive: boolean; reason: ListingStateReason; message: string | null }
> = {
  ACTIVE: { status: "active", isActive: true, reason: "active", message: null },
  // Live, not buyable. eBay keeps the listing and its item id; restocking brings
  // it straight back. Reporting this as ended is what made a relist mint a
  // duplicate of a listing that was still there.
  OUT_OF_STOCK: {
    status: "active",
    isActive: true,
    reason: "out_of_stock",
    message:
      "eBay shows this listing as out of stock, so buyers can't buy it right now. " +
      "It is still your listing — set the quantity above zero to bring it back, " +
      "rather than relisting (a relist would create a second listing).",
  },
  ENDED: {
    status: "ended",
    isActive: false,
    reason: "ended",
    message:
      "This listing has ended on eBay. Review the item and relist it when you're ready.",
  },
  // eBay's word for a listing it has taken down itself, most often a policy
  // issue. Naming that is the whole point of this module: "ended" sends the
  // seller to relist, which will just be taken down again.
  INACTIVE: {
    status: "ended",
    isActive: false,
    reason: "inactive",
    message:
      "eBay has made this listing inactive, which usually means eBay removed it " +
      "(often a listing-policy issue) rather than it ending on its own. Check " +
      "your eBay Seller Hub messages for the reason before relisting — a relist " +
      "of the same content is likely to be removed again.",
  },
  COMPLETED: {
    status: "ended",
    isActive: false,
    reason: "completed",
    message: "This listing is complete on eBay and is no longer live.",
  },
};

/**
 * Resolve one offer's listing state from what eBay returned.
 *
 * `listingStatus` is eBay's `offer.listing.listingStatus`. Pass `null` for an
 * offer that has no live listing at all.
 */
export function resolveEbayListingState(
  listingStatus: string | null | undefined,
): EbayListingState {
  const raw = (listingStatus ?? "").trim();
  if (!raw) {
    // No status at all. Not the same as "not in the feed" (see
    // absentListingState) — this is an offer eBay returned without a verdict, so
    // the old code's ACTIVE-or-nothing test made it ended. Keep ended, because a
    // listing we cannot confirm is live must not hold an activeListings slot,
    // but say plainly that we do not know why.
    return {
      status: "ended",
      isActive: false,
      ebayStatus: null,
      reason: "unknown_status",
      message:
        "eBay didn't report a status for this listing, so we've marked it not " +
        "live. Check it on eBay before relisting.",
    };
  }
  const upper = raw.toUpperCase();
  const known = KNOWN_STATUSES[upper];
  if (known) return { ...known, ebayStatus: upper };
  return {
    status: "ended",
    isActive: false,
    ebayStatus: upper,
    reason: "unknown_status",
    message:
      `eBay reports this listing as "${upper}", which we don't have a rule for ` +
      "yet, so we've marked it not live. Check it on eBay before relisting.",
  };
}

/**
 * The state for a listing that has VANISHED from eBay's active-offer feed.
 *
 * eBay drops a policy-removed listing out of the feed entirely rather than
 * returning it with a status, so absence is the only signal there is — and it is
 * a different fact from any status eBay could have sent, which is why it gets
 * its own reason instead of being folded into `ended`.
 */
export function absentListingState(): EbayListingState {
  return {
    status: "ended",
    isActive: false,
    ebayStatus: null,
    reason: "not_in_feed",
    message:
      "eBay no longer lists this as one of your active listings. It ended, sold " +
      "out, or was removed by eBay. Check your eBay Seller Hub messages if you " +
      "didn't end it yourself, then relist when you're ready.",
  };
}

// ── The post-sale half ─────────────────────────────────────────────────────
//
// A sale that reverses does not tell you, by itself, where the GARMENT is, and
// the two cases need opposite handling. The sync treated them as one and always
// put the item back to `listed`; the in-app return path (US-1451) put it to
// `returned`. Same event, two answers, depending on which code found it first.

export type SaleReversalKind = "cancelled_before_shipping" | "returned";

export interface OrderOutcome {
  /** sales.status */
  saleStatus: "completed" | "cancelled" | "refunded";
  /**
   * Where the garment is, for a reversal. Null for a completed sale.
   *
   *  • cancelled_before_shipping → it never left. Back into inventory, and the
   *    caller resyncs whether a live listing still exists rather than assuming.
   *  • returned → the buyer had it and sent it back. `returned` is the relist
   *    loop's entry point and is what the in-app path already writes.
   */
  reversal: SaleReversalKind | null;
}

/**
 * Classify an eBay order into the local sale status and, when it reversed, what
 * that means for the garment.
 *
 * The split is fulfilment, not payment: a cancel of an order that never shipped
 * leaves the item untouched on the shelf, while a refund on an order eBay
 * records as FULFILLED means the buyer had it and sent it back. A cancel eBay
 * accepted AFTER fulfilment is the same physical event as a return, so it is
 * classified as one.
 */
export function resolveOrderOutcome(order: {
  cancelState?: string | null;
  orderPaymentStatus?: string | null;
  orderFulfillmentStatus?: string | null;
}): OrderOutcome {
  const cancelled = (order.cancelState ?? "").toUpperCase() === "CANCELED";
  const refunded = (order.orderPaymentStatus ?? "").toUpperCase() === "FULLY_REFUNDED";
  if (!cancelled && !refunded) return { saleStatus: "completed", reversal: null };

  const fulfilled = (order.orderFulfillmentStatus ?? "").toUpperCase() === "FULFILLED";
  return {
    // cancelState wins the LABEL when both are set: an order eBay records as
    // canceled is a cancellation that happened to be refunded, and the money
    // reports read this field.
    saleStatus: cancelled ? "cancelled" : "refunded",
    reversal: fulfilled ? "returned" : "cancelled_before_shipping",
  };
}
