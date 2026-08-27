// US-2952: advertising in the money view.
//
// The property that carries the whole story is `reconcileMoneyLines`: the total
// is the SUM of the lines by construction, not a second computation that
// happens to agree. A profit figure a seller cannot reconcile against the rows
// above it is one they stop trusting and then stop using.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { extractAdFees, isAdFee, reconcileMoneyLines } = await import("../lib/ad-spend.ts");

const tx = (over: Partial<Parameters<typeof isAdFee>[0]> = {}) => ({
  transactionId: "t1",
  transactionType: "NON_SALE_CHARGE",
  transactionDate: "2026-08-20T00:00:00.000Z",
  orderId: "12-3456-7890",
  amount: { value: "4.20", currency: "USD" },
  feeType: "AD_FEE",
  ...over,
});

Deno.test("an ad fee is recognised across eBay's several spellings", () => {
  for (const feeType of ["AD_FEE", "PROMOTED_LISTING_FEE", "ADVERTISING", "CAMPAIGN_FEE"]) {
    assert(isAdFee(tx({ feeType })), feeType);
  }
});

Deno.test("a SALE is never an ad fee", () => {
  assertEquals(isAdFee(tx({ transactionType: "SALE" })), false);
  assertEquals(isAdFee(tx({ feeType: "INSERTION_FEE" })), false);
  assertEquals(isAdFee(tx({ feeType: null })), false);
});

Deno.test("extractAdFees keeps the ORDER link", () => {
  // Losing it would answer "how much did you spend on ads" and lose "what did
  // this jacket cost to sell", which is the question a seller actually asks.
  const out = extractAdFees([tx()]);
  assertEquals(out.length, 1);
  assertEquals(out[0]!.orderId, "12-3456-7890");
  assertEquals(out[0]!.cents, 420);
});

Deno.test("a charge with no readable amount is DROPPED, not counted as zero", () => {
  // Zero would report "you spent nothing on ads" from a feed that says
  // otherwise — the direction that flatters the profit figure.
  assertEquals(extractAdFees([tx({ amount: null })]).length, 0);
  assertEquals(extractAdFees([tx({ amount: { value: "n/a", currency: "USD" } })]).length, 0);
  assertEquals(extractAdFees([tx({ amount: { value: "0", currency: "USD" } })]).length, 0);
});

Deno.test("a negative amount is read as a cost, not as income", () => {
  // eBay signs a charge either way depending on the surface.
  assertEquals(extractAdFees([tx({ amount: { value: "-4.20", currency: "USD" } })])[0]!.cents, 420);
});

Deno.test("the total is the SUM of the lines, always", () => {
  const out = reconcileMoneyLines({
    revenueCents: 100_00,
    costOfGoodsCents: 30_00,
    platformFeesCents: 13_60,
    shippingCents: 8_00,
    adFeesCents: 4_20,
    promotionDiscountCents: 5_00,
  });
  assertEquals(
    out.totalCents,
    out.lines.reduce((s, l) => s + l.cents, 0),
    "the total must be the sum of the lines by construction",
  );
  assertEquals(out.totalCents, 100_00 - 30_00 - 13_60 - 8_00 - 4_20 - 5_00);
});

Deno.test("costs are negative whichever sign the caller passes", () => {
  const a = reconcileMoneyLines({
    revenueCents: 10_000,
    costOfGoodsCents: 3_000,
    platformFeesCents: 1_000,
    shippingCents: 0,
    adFeesCents: 500,
    promotionDiscountCents: 0,
  });
  const b = reconcileMoneyLines({
    revenueCents: 10_000,
    costOfGoodsCents: -3_000,
    platformFeesCents: -1_000,
    shippingCents: 0,
    adFeesCents: -500,
    promotionDiscountCents: 0,
  });
  assertEquals(a.totalCents, b.totalCents);
});

Deno.test("a zero AD line is kept, and every other zero line is dropped", () => {
  // "$0.00 in ad fees" is information — a seller checking whether their campaign
  // is charging at all. A $0 shipping line is noise.
  const out = reconcileMoneyLines({
    revenueCents: 10_000,
    costOfGoodsCents: 3_000,
    platformFeesCents: 0,
    shippingCents: 0,
    adFeesCents: 0,
    promotionDiscountCents: 0,
  });
  const keys = out.lines.map((l) => l.key);
  assert(keys.includes("ad_fees"));
  assert(!keys.includes("shipping"));
  assert(!keys.includes("platform_fees"));
});
