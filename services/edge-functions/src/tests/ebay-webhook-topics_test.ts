// US-471: eBay Notification topics must route to the right lifecycle bucket so
// order/sale events drive a targeted sync and return/cancellation events feed
// the returns/reversal handling. Substring matching keeps new topic-name
// variants working without a code change; this locks the classification.

import { assertEquals } from "@std/assert";
import { classifyEbayTopic } from "../lib/ebay-webhook-topics.ts";

Deno.test("payout topics classify as payout", () => {
  assertEquals(classifyEbayTopic("FINANCES_PAYOUT_INITIATED"), "payout");
  assertEquals(classifyEbayTopic("FINANCES_PAYOUT_PAID"), "payout");
  assertEquals(classifyEbayTopic("FINANCES_PAYOUT_FAILED"), "payout");
});

Deno.test("account deletion classifies separately", () => {
  assertEquals(
    classifyEbayTopic("MARKETPLACE_ACCOUNT_DELETION"),
    "account_deletion",
  );
});

Deno.test("order/sale topics classify as order", () => {
  assertEquals(classifyEbayTopic("ITEM_SOLD"), "order");
  assertEquals(classifyEbayTopic("FIXED_PRICE_TRANSACTION"), "order");
  assertEquals(classifyEbayTopic("ORDER_PAID"), "order");
  assertEquals(classifyEbayTopic("ORDER_SHIPPED"), "order");
  assertEquals(classifyEbayTopic("CHECKOUT_COMPLETE"), "order");
});

Deno.test("return/cancel/refund/dispute topics classify as return", () => {
  assertEquals(classifyEbayTopic("RETURN_CREATED"), "return");
  // Return on an order: "RETURN" wins over the "ORDER" substring.
  assertEquals(classifyEbayTopic("ORDER_RETURN_REQUESTED"), "return");
  assertEquals(classifyEbayTopic("ORDER_CANCEL_REQUESTED"), "return");
  assertEquals(classifyEbayTopic("REFUND_ISSUED"), "return");
  assertEquals(classifyEbayTopic("ITEM_NOT_RECEIVED_DISPUTE"), "return");
});

Deno.test("unknown topics classify as unhandled (metered, not order)", () => {
  assertEquals(classifyEbayTopic("SOME_FUTURE_TOPIC"), "unhandled");
  assertEquals(classifyEbayTopic("(unknown)"), "unhandled");
});
