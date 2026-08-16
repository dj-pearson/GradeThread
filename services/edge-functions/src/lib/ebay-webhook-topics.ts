// US-471: pure topic-classification for inbound eBay Notification events.
// Kept in its own lib module (no Supabase/Hono imports) so it's unit-testable
// without booting the service-role client the route module creates at load.

export type EbayTopicBucket =
  | "payout"
  | "order"
  | "return"
  | "listing"
  | "account_deletion"
  | "unhandled";

// Classify an eBay topic into the lifecycle bucket it drives. eBay's topic
// names vary across the Notification API and legacy Platform Notifications
// (e.g. ITEM_SOLD, FIXED_PRICE_TRANSACTION, ORDER_*, RETURN_*, CANCEL_*), so we
// match on substrings rather than an exact allow-list — a new order topic name
// still routes correctly without a code change.
//
// This function is load-bearing TWICE, which is why the order of the tests below
// is a correctness property and not style. The inbound receiver routes on it,
// and `ebay-notification-subscriptions.ts` decides which of eBay's topics to
// SUBSCRIBE by running eBay's own topic catalog through it and keeping the ones
// that land in a required bucket. A topic that classifies as `unhandled` is
// therefore not merely dropped on arrival — it is never subscribed, so it never
// arrives at all.
export function classifyEbayTopic(topic: string): EbayTopicBucket {
  const t = topic.toUpperCase();
  if (t.startsWith("FINANCES_PAYOUT")) return "payout";
  if (t.includes("ACCOUNT_DELETION")) return "account_deletion";
  // Returns/cancellations/refunds/disputes feed the returns + reversal handling.
  // Checked BEFORE the order bucket because some return topics also contain
  // "ORDER" (e.g. ORDER_RETURN_REQUESTED).
  if (
    t.includes("RETURN") ||
    t.includes("CANCEL") ||
    t.includes("REFUND") ||
    t.includes("DISPUTE") ||
    t.includes("INQUIRY") ||
    // A buyer CASE is a post-sale dispute. Added in US-2656 because the listing
    // bucket below claims "CLOSED", and without this CASE_CLOSED would route
    // there — a buyer case resolving would have been read as a listing event.
    // Anchored on the underscore so it cannot catch a word merely ending in it.
    t.includes("CASE_")
  ) {
    return "return";
  }
  // US-2656: the LISTING lifecycle — a listing ending, closing, being taken down
  // by eBay, or running out of stock. Before this there was no such bucket, so
  // every one of these topics classified as `unhandled` and, by the rule above,
  // was never subscribed: the only way FlipDesk learned a listing had ended was
  // the 30-minute backstop pull noticing it was gone.
  //
  // This block MUST precede the order block, and the reason is one word:
  // ITEM_UNSOLD contains "SOLD". Ordered the other way, an auction that closed
  // WITHOUT a buyer would route to the sale bucket. Same trap in reverse for
  // "RELISTED", which contains "LISTED".
  //
  // Every term here is a listing verb that cannot appear in a sale topic. The
  // return block above already claimed CANCEL/RETURN, so a RETURN_CLOSED still
  // routes to returns rather than being caught by CLOSED.
  if (
    t.includes("UNSOLD") ||
    t.includes("OUT_OF_STOCK") ||
    t.includes("ENDED") ||
    t.includes("CLOSED") ||
    t.includes("REVISED") ||
    t.includes("RELISTED") ||
    t.includes("REMOVED") ||
    t.includes("LISTING_")
  ) {
    return "listing";
  }
  // Order/sale lifecycle: a sale was made, paid, or shipped.
  if (
    t.includes("ORDER") ||
    t.includes("SOLD") ||
    t.includes("SALE") ||
    t.includes("TRANSACTION") ||
    t.includes("CHECKOUT") ||
    t.includes("PAYMENT")
  ) {
    return "order";
  }
  // Remaining ITEM_* topics are listing-lifecycle by elimination — the sale
  // shapes (ITEM_SOLD, FIXED_PRICE_TRANSACTION) were claimed above. Last so it
  // can never shadow a more specific rule.
  if (t.startsWith("ITEM_")) return "listing";
  return "unhandled";
}
