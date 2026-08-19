import { assertEquals } from "@std/assert";
import {
  absentListingState,
  resolveEbayListingState,
  resolveOrderOutcome,
} from "../lib/ebay-listing-state.ts";
import { classifyEbayTopic } from "../lib/ebay-webhook-topics.ts";

// ebay-notification-subscriptions.ts reaches ebay-client.ts, which builds the
// service-role supabase client at load — dummy env before the dynamic import,
// the same pattern offer-already-ended_test.ts uses.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const { REQUIRED_BUCKETS } = await import(
  "../lib/ebay-notification-subscriptions.ts"
);

// US-2656: eBay tells us WHY a listing stopped being active, and the sync used
// to reduce every answer to the word "ended".

// ── Listing state ──────────────────────────────────────────────────────────

Deno.test("ACTIVE is live and needs no explanation", () => {
  const s = resolveEbayListingState("ACTIVE");
  assertEquals(s.status, "active");
  assertEquals(s.isActive, true);
  assertEquals(s.reason, "active");
  assertEquals(s.message, null);
});

Deno.test("OUT_OF_STOCK stays ACTIVE — the listing is still on eBay", () => {
  // The old ternary made this "ended", which invited a relist that would have
  // created a second listing alongside the one still sitting there.
  const s = resolveEbayListingState("OUT_OF_STOCK");
  assertEquals(s.status, "active");
  assertEquals(s.isActive, true);
  assertEquals(s.reason, "out_of_stock");
  assertEquals(typeof s.message, "string");
});

// US-2684: eBay reaches out-of-stock two ways and only said the word one of
// them. A cancelled order takes availableQuantity to 0 and leaves listingStatus
// reading ACTIVE, which resolved to a plain live listing — so the app showed a
// green "buyers can purchase it now" banner over something nobody could buy.

Deno.test("quantity 0 on an ACTIVE listing is out of stock", () => {
  // The state a cancelled eBay order leaves behind. eBay decrements the
  // quantity when the order is placed and never restores it on cancel.
  const s = resolveEbayListingState("ACTIVE", 0);
  assertEquals(s.reason, "out_of_stock");
  assertEquals(s.status, "active");
  assertEquals(s.isActive, true);
  // eBay's own word survives — the override changes the MEANING, not the record
  // of what eBay actually said.
  assertEquals(s.ebayStatus, "ACTIVE");
});

Deno.test("a missing quantity is unknown, never zero", () => {
  // An offer eBay returned without the field must not be reported unbuyable:
  // that would put a stop-everything banner over a perfectly healthy listing,
  // which is how a seller learns to ignore the banner.
  assertEquals(resolveEbayListingState("ACTIVE", null).reason, "active");
  assertEquals(resolveEbayListingState("ACTIVE", undefined).reason, "active");
  assertEquals(resolveEbayListingState("ACTIVE", NaN).reason, "active");
  assertEquals(resolveEbayListingState("ACTIVE", 1).reason, "active");
});

Deno.test("the stock floor never revives a listing that is not live", () => {
  // An ENDED listing at quantity 0 is ended. Calling it out-of-stock would say
  // it is still on eBay and restockable, and it is neither.
  const ended = resolveEbayListingState("ENDED", 0);
  assertEquals(ended.reason, "ended");
  assertEquals(ended.isActive, false);
  const inactive = resolveEbayListingState("INACTIVE", 0);
  assertEquals(inactive.reason, "inactive");
  assertEquals(inactive.isActive, false);
});

Deno.test("a listing eBay already calls OUT_OF_STOCK is unchanged by the floor", () => {
  const withQty = resolveEbayListingState("OUT_OF_STOCK", 0);
  const withoutQty = resolveEbayListingState("OUT_OF_STOCK");
  assertEquals(withQty.reason, withoutQty.reason);
  assertEquals(withQty.message, withoutQty.message);
  assertEquals(withQty.ebayStatus, "OUT_OF_STOCK");
});

Deno.test("INACTIVE is eBay taking it down, and says so", () => {
  const s = resolveEbayListingState("INACTIVE");
  assertEquals(s.status, "ended");
  assertEquals(s.isActive, false);
  assertEquals(s.reason, "inactive");
  // The distinction that matters: this must NOT read as "relist it".
  assertEquals(s.message?.includes("eBay removed it"), true);
});

Deno.test("ENDED and COMPLETED are ended, and are told apart", () => {
  assertEquals(resolveEbayListingState("ENDED").reason, "ended");
  assertEquals(resolveEbayListingState("COMPLETED").reason, "completed");
  assertEquals(resolveEbayListingState("ENDED").status, "ended");
  assertEquals(resolveEbayListingState("COMPLETED").status, "ended");
});

Deno.test("status matching is case- and whitespace-insensitive", () => {
  assertEquals(resolveEbayListingState("  active ").reason, "active");
  assertEquals(resolveEbayListingState("Out_Of_Stock").reason, "out_of_stock");
});

Deno.test("an unrecognised status is carried verbatim, not folded into a neighbour", () => {
  // This is how we learn eBay's real vocabulary: the raw word lands in the data
  // as itself rather than silently becoming "ended" with no trace.
  const s = resolveEbayListingState("EENDED");
  assertEquals(s.reason, "unknown_status");
  assertEquals(s.ebayStatus, "EENDED");
  assertEquals(s.status, "ended");
  assertEquals(s.message?.includes("EENDED"), true);
});

Deno.test("no status at all is ended, and admits it doesn't know why", () => {
  for (const v of [null, undefined, "", "   "]) {
    const s = resolveEbayListingState(v);
    assertEquals(s.status, "ended");
    assertEquals(s.reason, "unknown_status");
    assertEquals(s.ebayStatus, null);
  }
});

Deno.test("absence from the feed is its own reason, not 'ended'", () => {
  // eBay drops a policy-removed listing out of the feed entirely, so absence is
  // a different fact from any status it could have sent.
  const s = absentListingState();
  assertEquals(s.reason, "not_in_feed");
  assertEquals(s.status, "ended");
  assertEquals(s.isActive, false);
});

// ── Order outcome: where is the garment? ───────────────────────────────────

Deno.test("a clean order is completed with no reversal", () => {
  assertEquals(
    resolveOrderOutcome({
      cancelState: "NONE_REQUESTED",
      orderPaymentStatus: "PAID",
      orderFulfillmentStatus: "FULFILLED",
    }),
    { saleStatus: "completed", reversal: null },
  );
});

Deno.test("cancelled before shipping — the garment never left", () => {
  assertEquals(
    resolveOrderOutcome({
      cancelState: "CANCELED",
      orderPaymentStatus: "FULLY_REFUNDED",
      orderFulfillmentStatus: "NOT_STARTED",
    }),
    { saleStatus: "cancelled", reversal: "cancelled_before_shipping" },
  );
});

Deno.test("refunded after fulfilment — the buyer had it and sent it back", () => {
  // The case the sync never had: an eBay-side refund on a shipped order. It used
  // to put the item back to 'listed' as though nothing had been posted.
  assertEquals(
    resolveOrderOutcome({
      cancelState: "NONE_REQUESTED",
      orderPaymentStatus: "FULLY_REFUNDED",
      orderFulfillmentStatus: "FULFILLED",
    }),
    { saleStatus: "refunded", reversal: "returned" },
  );
});

Deno.test("a cancel eBay accepted AFTER fulfilment is physically a return", () => {
  // Same garment movement as a return, so it gets the same disposition — while
  // the sale keeps the 'cancelled' label the money reports read.
  assertEquals(
    resolveOrderOutcome({
      cancelState: "CANCELED",
      orderPaymentStatus: "FULLY_REFUNDED",
      orderFulfillmentStatus: "FULFILLED",
    }),
    { saleStatus: "cancelled", reversal: "returned" },
  );
});

Deno.test("a pending cancel request is not yet a reversal", () => {
  assertEquals(
    resolveOrderOutcome({
      cancelState: "CANCEL_REQUESTED",
      orderPaymentStatus: "PAID",
      orderFulfillmentStatus: "NOT_STARTED",
    }),
    { saleStatus: "completed", reversal: null },
  );
});

// ── Topic routing ──────────────────────────────────────────────────────────
//
// The order of the tests inside classifyEbayTopic is a correctness property:
// the router decides both what is HANDLED and, through REQUIRED_BUCKETS, what is
// ever SUBSCRIBED. A topic that classifies wrong is a topic that acts wrong or
// never arrives.

Deno.test("ITEM_UNSOLD is a listing event, not a sale (it contains 'SOLD')", () => {
  assertEquals(classifyEbayTopic("ITEM_UNSOLD"), "listing");
});

Deno.test("ITEM_SOLD is still a sale", () => {
  assertEquals(classifyEbayTopic("ITEM_SOLD"), "order");
  assertEquals(classifyEbayTopic("FIXED_PRICE_TRANSACTION"), "order");
});

Deno.test("listing lifecycle topics route to the listing bucket", () => {
  for (
    const t of [
      "ITEM_CLOSED",
      "ITEM_ENDED",
      "ITEM_OUT_OF_STOCK",
      "ITEM_REVISED",
      "ITEM_RELISTED",
      "ITEM_REMOVED",
      "ITEM_LISTED",
      "LISTING_ENDED",
    ]
  ) {
    assertEquals(classifyEbayTopic(t), "listing", `${t} should be a listing event`);
  }
});

Deno.test("returns still win over the listing bucket's CLOSED/CANCEL terms", () => {
  // RETURN_CLOSED contains "CLOSED"; ORDER_CANCELLED contains "CANCEL". Both
  // must stay in the returns bucket, which drives the reversal handling.
  assertEquals(classifyEbayTopic("RETURN_CLOSED"), "return");
  assertEquals(classifyEbayTopic("ORDER_CANCELLED"), "return");
  assertEquals(classifyEbayTopic("CASE_CLOSED"), "return");
  assertEquals(classifyEbayTopic("DISPUTE_CLOSED"), "return");
});

Deno.test("payout and account-deletion routing is unchanged", () => {
  assertEquals(classifyEbayTopic("FINANCES_PAYOUT_STATUS_CHANGE"), "payout");
  assertEquals(
    classifyEbayTopic("MARKETPLACE_ACCOUNT_DELETION"),
    "account_deletion",
  );
});

Deno.test("the listing bucket is REQUIRED, or its topics are never subscribed", () => {
  // Subscription is derived from this list: a bucket missing here means eBay is
  // never asked to deliver those topics, so handling them changes nothing.
  assertEquals(REQUIRED_BUCKETS.includes("listing"), true);
});
