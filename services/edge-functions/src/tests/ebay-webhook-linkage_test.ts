// US-472: webhook → seller linkage must be reliable. eBay payout/order/return
// payloads carry the seller under a few different shapes; we capture BOTH the
// stable userId (matched against external_account_id) and the free-text handle
// (matched against account_handle) so an event can link even when only one is
// present. These tests pin the candidate extraction + payout parsing the live
// handler and the parked-event drain both depend on.

import { assertEquals } from "@std/assert";
import {
  extractEbayCandidates,
  parsePayoutRow,
} from "../routes/flipdesk-webhooks.ts";

Deno.test("extractEbayCandidates reads seller.userId + seller.username", () => {
  const c = extractEbayCandidates({
    seller: { username: "thrift_co", userId: "EBAY-123" },
  });
  assertEquals(c.username, "thrift_co");
  assertEquals(c.ebayUserId, "EBAY-123");
});

Deno.test("extractEbayCandidates reads payout-shaped payee/payeeId", () => {
  // Finances payout notifications carry the seller as user/payee + payeeId.
  const c = extractEbayCandidates({
    payeeId: "EBAY-999",
    user: { username: "vintage_finds" },
  });
  assertEquals(c.username, "vintage_finds");
  assertEquals(c.ebayUserId, "EBAY-999");
});

Deno.test("extractEbayCandidates falls back to flat sellerId/username", () => {
  const c = extractEbayCandidates({ sellerId: "EBAY-777", username: "flat_seller" });
  assertEquals(c.username, "flat_seller");
  assertEquals(c.ebayUserId, "EBAY-777");
});

Deno.test("extractEbayCandidates returns nulls when nothing identifies the seller", () => {
  const c = extractEbayCandidates({ payoutId: "P-1" });
  assertEquals(c.username, null);
  assertEquals(c.ebayUserId, null);
});

Deno.test("parsePayoutRow parses a complete payout payload", () => {
  const row = parsePayoutRow(
    {
      payoutId: "P-42",
      payoutDate: "2026-06-12T08:00:00.000Z",
      payoutStatus: "SUCCEEDED",
      amount: { value: "123.45", currencyCode: "USD" },
    },
    "FINANCES_PAYOUT_PAID",
  );
  assertEquals(row?.payoutId, "P-42");
  assertEquals(row?.payoutDate, "2026-06-12"); // truncated to date
  assertEquals(row?.amount, 123.45);
  assertEquals(row?.currency, "USD");
  assertEquals(row?.status, "SUCCEEDED");
});

Deno.test("parsePayoutRow derives status from topic when payoutStatus absent", () => {
  const row = parsePayoutRow(
    {
      payoutId: "P-43",
      payoutDate: "2026-06-12",
      totalNetAmount: { value: 10, currencyCode: "GBP" },
    },
    "FINANCES_PAYOUT_INITIATED",
  );
  assertEquals(row?.status, "INITIATED");
  assertEquals(row?.currency, "GBP");
  assertEquals(row?.amount, 10);
});

Deno.test("parsePayoutRow returns null when required fields are missing", () => {
  // Missing amount → cannot ingest.
  assertEquals(
    parsePayoutRow({ payoutId: "P-44", payoutDate: "2026-06-12" }, "FINANCES_PAYOUT_PAID"),
    null,
  );
  // Missing payoutId → cannot ingest.
  assertEquals(
    parsePayoutRow(
      { payoutDate: "2026-06-12", amount: { value: "5", currencyCode: "USD" } },
      "FINANCES_PAYOUT_PAID",
    ),
    null,
  );
});
