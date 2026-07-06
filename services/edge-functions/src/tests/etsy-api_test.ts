// US-1660: pure helpers of the Etsy listing/receipt layer — the form-body
// builder, the money parser, and the receipt/refund parsers. These are the
// buildable-without-a-token surfaces; the token-gated CRUD is exercised by the
// adapter test + (once app approval lands) a sandbox.

// etsy-api.ts transitively imports the service-role client (via etsy-client),
// which throws at module init without env — set dummy env BEFORE the dynamic
// import (mirrors etsy-client_test / marketplace-adapters_test).
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  buildEtsyListingParams,
  etsyMoney,
  etsyRefundStatus,
  parseEtsyReceipt,
} = await import("../lib/etsy-api.ts");
type EtsyListingInput = Parameters<typeof buildEtsyListingParams>[0];

// ── etsyMoney ─────────────────────────────────────────────────────────

Deno.test("etsyMoney divides amount by divisor", () => {
  assertEquals(etsyMoney({ amount: 1234, divisor: 100 }), 12.34);
  assertEquals(etsyMoney({ amount: 500, divisor: 100 }), 5);
  // Missing/zero divisor falls back to 100.
  assertEquals(etsyMoney({ amount: 999 }), 9.99);
  assertEquals(etsyMoney({ amount: 100, divisor: 0 }), 1);
  // Plain number passes through; null → 0.
  assertEquals(etsyMoney(7.5), 7.5);
  assertEquals(etsyMoney(null), 0);
});

// ── buildEtsyListingParams ────────────────────────────────────────────

function baseInput(overrides: Partial<EtsyListingInput> = {}): EtsyListingInput {
  return {
    title: "Vintage wool coat",
    description: "Warm and structured.",
    price: 48,
    taxonomyId: 1234,
    shippingProfileId: 5678,
    ...overrides,
  };
}

Deno.test("buildEtsyListingParams sets the required physical-listing fields", () => {
  const p = buildEtsyListingParams(baseInput());
  assertEquals(p.get("title"), "Vintage wool coat");
  assertEquals(p.get("description"), "Warm and structured.");
  assertEquals(p.get("price"), "48.00");
  assertEquals(p.get("quantity"), "1");
  assertEquals(p.get("taxonomy_id"), "1234");
  assertEquals(p.get("shipping_profile_id"), "5678");
  assertEquals(p.get("type"), "physical");
  assertEquals(p.get("who_made"), "someone_else");
  assertEquals(p.get("when_made"), "before_2005");
  assertEquals(p.get("is_supply"), "false");
});

Deno.test("buildEtsyListingParams clamps title to 140 and sanitizes tags", () => {
  const p = buildEtsyListingParams(
    baseInput({
      title: "x".repeat(200),
      tags: [
        "clean tag",
        "has,comma",
        "waaaaaaaaaaaaaaaaaaaaaaaaaaytoolong",
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", // >13
      ],
    }),
  );
  assertEquals(p.get("title")!.length, 140);
  const tags = p.getAll("tags");
  assertEquals(tags.length, 13); // capped at 13
  assert(tags.every((t) => t.length <= 20), "each tag ≤20 chars");
  assert(tags.every((t) => !t.includes(",")), "no commas in tags");
});

Deno.test("buildEtsyListingParams emits materials as repeated params", () => {
  const p = buildEtsyListingParams(baseInput({ materials: ["wool", "polyester"] }));
  assertEquals(p.getAll("materials"), ["wool", "polyester"]);
});

// ── parseEtsyReceipt ──────────────────────────────────────────────────

Deno.test("parseEtsyReceipt normalizes money, buyer, timestamp, and transactions", () => {
  const receipt = parseEtsyReceipt({
    receipt_id: 998877,
    status: "paid",
    name: "Jane Buyer",
    created_timestamp: 1_700_000_000,
    is_shipped: false,
    grandtotal: { amount: 4800, divisor: 100, currency_code: "USD" },
    transactions: [
      {
        transaction_id: 1,
        listing_id: 555,
        sku: "GT-ABC",
        quantity: 1,
        price: { amount: 4800, divisor: 100, currency_code: "USD" },
      },
    ],
  });
  assert(receipt);
  assertEquals(receipt!.receiptId, "998877");
  assertEquals(receipt!.status, "paid");
  assertEquals(receipt!.buyerName, "Jane Buyer");
  assertEquals(receipt!.total, 48);
  assertEquals(receipt!.transactions.length, 1);
  assertEquals(receipt!.transactions[0]!.listingId, "555");
  assertEquals(receipt!.transactions[0]!.sku, "GT-ABC");
  assertEquals(receipt!.transactions[0]!.price, 48);
  assert(receipt!.soldAt?.startsWith("2023-"));
});

Deno.test("parseEtsyReceipt returns null without a receipt id", () => {
  assertEquals(parseEtsyReceipt({ status: "paid" }), null);
  assertEquals(parseEtsyReceipt(null), null);
});

// ── etsyRefundStatus ──────────────────────────────────────────────────

Deno.test("etsyRefundStatus maps cancel/refund; null for a live sale", () => {
  const mk = (status: string) => ({
    receiptId: "1",
    status,
    currency: "USD",
    total: 10,
    buyerName: null,
    soldAt: null,
    isShipped: false,
    transactions: [],
  });
  assertEquals(etsyRefundStatus(mk("canceled")), "cancelled");
  assertEquals(etsyRefundStatus(mk("Fully Refunded")), "refunded");
  assertEquals(etsyRefundStatus(mk("paid")), null);
  assertEquals(etsyRefundStatus(mk("completed")), null);
});
