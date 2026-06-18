// ebay-disputes.ts imports ebay-client.ts which imports supabase.ts at load;
// set env vars before the dynamic import to avoid "SUPABASE_URL is not set".
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

import { assertEquals } from "@std/assert";

const {
  disputeOutcomeToSaleStatus,
  isBenignDisputeNotFound,
  normalizePaymentDispute,
} = await import("../lib/ebay-disputes.ts");

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

// ── 404 → empty mapping (US-1087) ───────────────────────────────────

Deno.test("isBenignDisputeNotFound: 404 DisputeError is benign", () => {
  const err = Object.assign(new Error("eBay 404"), { status: 404 });
  assertEquals(isBenignDisputeNotFound(err), true);
});

Deno.test("isBenignDisputeNotFound: non-404 statuses are not benign", () => {
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    const err = Object.assign(new Error(`eBay ${status}`), { status });
    assertEquals(isBenignDisputeNotFound(err), false, `status ${status} should not be benign`);
  }
});

Deno.test("isBenignDisputeNotFound: plain Error (no status) is not benign", () => {
  assertEquals(isBenignDisputeNotFound(new Error("timeout")), false);
});

Deno.test("isBenignDisputeNotFound: non-Error values are not benign", () => {
  assertEquals(isBenignDisputeNotFound(null), false);
  assertEquals(isBenignDisputeNotFound(undefined), false);
  assertEquals(isBenignDisputeNotFound({ status: 404 }), false);
});
