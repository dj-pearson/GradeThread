import { assertEquals } from "@std/assert";
import {
  disputeOutcomeToSaleStatus,
  normalizePaymentDispute,
} from "../lib/ebay-disputes.ts";

Deno.test("normalizePaymentDispute flattens the dispute shape", () => {
  const d = normalizePaymentDispute({
    paymentDisputeId: "5000-abc",
    orderId: "12-09999-88888",
    paymentDisputeStatus: "ACTION_NEEDED",
    reason: "ITEM_NOT_RECEIVED",
    amount: { value: "42.50", currency: "USD" },
    openDate: "2026-06-10T00:00:00Z",
    respondByDate: "2026-06-17T00:00:00Z",
    buyerUsername: "buyer_bob",
  });
  assertEquals(d.paymentDisputeId, "5000-abc");
  assertEquals(d.orderId, "12-09999-88888");
  assertEquals(d.status, "ACTION_NEEDED");
  assertEquals(d.reason, "ITEM_NOT_RECEIVED");
  assertEquals(d.amount, 42.5);
  assertEquals(d.currency, "USD");
  assertEquals(d.respondByDate, "2026-06-17T00:00:00Z");
  assertEquals(d.buyerUsername, "buyer_bob");
});

Deno.test("normalizePaymentDispute tolerates missing fields", () => {
  const d = normalizePaymentDispute({});
  assertEquals(d.paymentDisputeId, "");
  assertEquals(d.amount, null);
  assertEquals(d.status, null);
  assertEquals(d.respondByDate, null);
});

Deno.test("disputeOutcomeToSaleStatus: accept refunds, contest is pending", () => {
  assertEquals(disputeOutcomeToSaleStatus("accepted"), "refunded");
  assertEquals(disputeOutcomeToSaleStatus("contested"), null);
});
