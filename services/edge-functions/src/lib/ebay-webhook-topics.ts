// US-471: pure topic-classification for inbound eBay Notification events.
// Kept in its own lib module (no Supabase/Hono imports) so it's unit-testable
// without booting the service-role client the route module creates at load.

export type EbayTopicBucket =
  | "payout"
  | "order"
  | "return"
  | "account_deletion"
  | "unhandled";

// Classify an eBay topic into the lifecycle bucket it drives. eBay's topic
// names vary across the Notification API and legacy Platform Notifications
// (e.g. ITEM_SOLD, FIXED_PRICE_TRANSACTION, ORDER_*, RETURN_*, CANCEL_*), so we
// match on substrings rather than an exact allow-list — a new order topic name
// still routes correctly without a code change.
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
    t.includes("INQUIRY")
  ) {
    return "return";
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
  return "unhandled";
}
