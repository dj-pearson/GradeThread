import { describe, it, expect } from "vitest";
import {
  ATHLETIC_SHOE_THRESHOLD,
  DISPUTE_FEE,
  EBAY_FEES_RETRIEVED_ON,
  FREE_LISTINGS_PER_MONTH,
  INSERTION_FEE,
  STORE_MONTHLY_COST,
  calculateEbayFees,
  finalValueFee,
  skipsPerOrderFee,
  surchargePoints,
  type FeeInput,
} from "../ebay-fee-schedule";

// US-9003. Every expected number below is computed by hand in its own comment,
// because a fee calculator whose test says `toBe(calculateEbayFees(...))` in
// another shape proves only that the code agrees with itself. The schedule
// itself is docs/seo/ebay-fee-schedule-CONFIRMED.csv, read off eBay's own pages
// on 2026-08-18.

const BASE: FeeInput = {
  itemPrice: 0,
  shippingCharged: 0,
  salesTax: 0,
  itemCost: 0,
  shippingCost: 0,
  category: "apparel",
  storeTier: "none",
  listingFormat: "fixed",
  startingPrice: 0,
  pastFreeListings: false,
  adRatePct: 0,
  international: false,
  offersEbayInternationalShipping: false,
  currencyConverted: false,
  standing: "good",
  lostDispute: false,
};

describe("final value fee shapes (US-9003)", () => {
  it("charges apparel a flat rate below the cap", () => {
    // 13.6% of $100 = $13.60
    expect(finalValueFee(100, "apparel", "none").amount).toBe(13.6);
    // Basic Store and above: 12.7% of $100 = $12.70
    expect(finalValueFee(100, "apparel", "basic").amount).toBe(12.7);
  });

  it("gives Starter Store no discount at all", () => {
    // The most surprising line in the schedule: Starter pays the no-Store rate.
    expect(finalValueFee(100, "apparel", "starter").amount).toBe(
      finalValueFee(100, "apparel", "none").amount,
    );
    expect(finalValueFee(100, "apparel", "starter").amount).not.toBe(
      finalValueFee(100, "apparel", "basic").amount,
    );
  });

  it("tapers apparel above the cap rather than re-rating the whole sale", () => {
    // No Store, $8,000 sale. Cap is $7,500.
    //   13.6% of 7,500       = 1,020.00
    //   2.35% of the last 500 =    11.75
    //                          = 1,031.75
    expect(finalValueFee(8000, "apparel", "none").amount).toBe(1031.75);
    // Basic Store, same sale. Cap is $2,500.
    //   12.7% of 2,500        =   317.50
    //   2.35% of the last 5,500 =  129.25
    //                           =   446.75
    expect(finalValueFee(8000, "apparel", "basic").amount).toBe(446.75);
  });

  it("re-rates a handbag's whole sale at the cliff, so $2,001 costs less than $1,999", () => {
    // 15% of 1,999 = 299.85 ; 9% of 2,001 = 180.09
    expect(finalValueFee(1999, "handbags", "none").amount).toBe(299.85);
    expect(finalValueFee(2001, "handbags", "none").amount).toBe(180.09);
    expect(finalValueFee(2001, "handbags", "none").amount).toBeLessThan(
      finalValueFee(1999, "handbags", "none").amount,
    );
    // Basic Store and above: 13% / 7%.
    expect(finalValueFee(1999, "handbags", "premium").amount).toBe(259.87);
    expect(finalValueFee(2001, "handbags", "premium").amount).toBe(140.07);
  });

  it("drops the athletic-shoe rate at $150 and falls back below it", () => {
    // 8% of 150 = 12.00
    expect(finalValueFee(150, "athletic-shoes", "none").amount).toBe(12);
    // A cent under the threshold it is ordinary apparel: 13.6% of 149.99 = 20.398...
    expect(finalValueFee(149.99, "athletic-shoes", "none").amount).toBe(20.4);
    // Basic Store and above: 7% of 200 = 14.00
    expect(finalValueFee(200, "athletic-shoes", "anchor").amount).toBe(14);
  });

  it("skips the per-order fee only for athletic shoes at the threshold", () => {
    expect(skipsPerOrderFee(150, "athletic-shoes")).toBe(true);
    expect(skipsPerOrderFee(149.99, "athletic-shoes")).toBe(false);
    expect(skipsPerOrderFee(1000, "apparel")).toBe(false);
  });
});

describe("seller-standing surcharges (US-9003)", () => {
  it("escalates, and never stacks the two kinds", () => {
    expect(surchargePoints("good")).toBe(0);
    expect(surchargePoints("below-standard")).toBe(6);
    expect(surchargePoints("below-standard-4mo")).toBe(7);
    expect(surchargePoints("inad-very-high")).toBe(5);
    expect(surchargePoints("inad-very-high-4mo")).toBe(6);
    // A seller who is both is charged the Below Standard one only. The type
    // makes that structural: standing is one value, so there is nothing to add.
  });
});

describe("worked examples (US-9003 AC5)", () => {
  it("a $40 hoodie with $8 shipping, no Store, unpromoted", () => {
    const r = calculateEbayFees({
      ...BASE,
      itemPrice: 40,
      shippingCharged: 8,
      itemCost: 12,
      shippingCost: 6.5,
    });
    // Sale total          = 48.00
    // FVF 13.6% of 48.00  =  6.528 -> 6.53
    // Per-order, over $10 =  0.40
    // Total fees          =  6.93
    // Payout 48.00 - 6.93 = 41.07
    // Profit 41.07 - 12 - 6.50 = 22.57
    expect(r.saleTotal).toBe(48);
    expect(r.totalFees).toBe(6.93);
    expect(r.payout).toBe(41.07);
    expect(r.profit).toBe(22.57);
  });

  it("a $220 pair of sneakers: reduced rate AND no per-order fee", () => {
    const r = calculateEbayFees({
      ...BASE,
      category: "athletic-shoes",
      itemPrice: 205,
      shippingCharged: 15,
      startingPrice: 205,
      pastFreeListings: true,
      itemCost: 90,
      shippingCost: 12,
    });
    // Sale total        = 220.00, which clears $150
    // FVF 8% of 220     =  17.60
    // Per-order fee     =   0.00  (waived for athletic shoes at $150+)
    // Insertion fee     =   0.00  (start price $205 clears $150: free at every tier)
    // Total fees        =  17.60
    // Payout            = 202.40
    // Profit            = 100.40
    expect(r.totalFees).toBe(17.6);
    expect(r.payout).toBe(202.4);
    expect(r.profit).toBe(100.4);
    expect(r.lines.find((l) => l.label === "Insertion fee")).toBeUndefined();
  });

  it("the same shoes listed at $140: the whole shape changes", () => {
    const r = calculateEbayFees({
      ...BASE,
      category: "athletic-shoes",
      itemPrice: 140,
      shippingCharged: 0,
      startingPrice: 140,
      pastFreeListings: true,
    });
    // Sale total          = 140.00, under $150
    // FVF 13.6% of 140    =  19.04   (apparel fallback, not 8%)
    // Per-order fee       =   0.40   (charged again)
    // Insertion fee       =   0.35   (start price misses $150, no Store)
    // Total fees          =  19.79
    expect(r.totalFees).toBe(19.79);
    expect(r.lines.find((l) => l.label === "Insertion fee")?.amount).toBe(0.35);
  });

  it("crosses the free-listing threshold on an Anchor Store auction", () => {
    const inside = calculateEbayFees({
      ...BASE,
      itemPrice: 50,
      storeTier: "anchor",
      listingFormat: "auction",
      pastFreeListings: false,
    });
    const past = calculateEbayFees({
      ...BASE,
      itemPrice: 50,
      storeTier: "anchor",
      listingFormat: "auction",
      pastFreeListings: true,
    });
    // Anchor auction insertion fee is $0.10, and only past the free 25,000.
    expect(money(past.totalFees - inside.totalFees)).toBe(0.1);
    expect(INSERTION_FEE.anchor.auction).toBe(0.1);
    expect(INSERTION_FEE.anchor.fixed).toBe(0.05);
    expect(FREE_LISTINGS_PER_MONTH.anchor).toBe(25000);
  });

  it("a promoted international sale to a Below Standard seller", () => {
    const r = calculateEbayFees({
      ...BASE,
      itemPrice: 100,
      shippingCharged: 20,
      salesTax: 10,
      adRatePct: 5,
      international: true,
      standing: "below-standard",
    });
    // Sale total            = 130.00  (item + shipping + tax all count)
    // FVF 13.6% of 130      =  17.68
    // Per-order             =   0.40
    // Standing +6 pts       =   7.80
    // Promoted 5%           =   6.50
    // International 1.65%   =   2.145 -> 2.15
    // Total fees            =  34.53
    // Payout 130 - 34.53 - 10 (tax remitted) = 85.47
    expect(r.saleTotal).toBe(130);
    expect(r.totalFees).toBe(34.53);
    expect(r.payout).toBe(85.47);
    expect(r.effectiveFeePct).toBe(26.56);
  });

  it("waives the international fee when eBay International Shipping is offered", () => {
    const withFee = calculateEbayFees({ ...BASE, itemPrice: 100, international: true });
    const waived = calculateEbayFees({
      ...BASE,
      itemPrice: 100,
      international: true,
      offersEbayInternationalShipping: true,
    });
    expect(money(withFee.totalFees - waived.totalFees)).toBe(1.65);
  });

  it("adds the flat dispute fee, which dwarfs the per-order fee", () => {
    const r = calculateEbayFees({ ...BASE, itemPrice: 30, lostDispute: true });
    expect(r.lines.find((l) => l.label === "Dispute fee")?.amount).toBe(DISPUTE_FEE);
    expect(DISPUTE_FEE).toBeGreaterThan(0.4 * 40);
  });
});

describe("the schedule as data (US-9003)", () => {
  it("separates yearly-renewal from monthly-renewal store pricing", () => {
    // The original sheet had one column labelled "billed annually" holding the
    // MONTHLY-renewal prices, which would have overstated every store cost.
    expect(STORE_MONTHLY_COST.starter).toEqual({ yearly: 4.95, monthly: 7.95 });
    expect(STORE_MONTHLY_COST.anchor).toEqual({ yearly: 299.95, monthly: 349.95 });
    // Enterprise is yearly-renewal only.
    expect(STORE_MONTHLY_COST.enterprise.monthly).toBeNull();
  });

  it("states the day it was read, and it is a real date in the past", () => {
    // eBay prints no version stamp on either fee page, so an effectiveFrom
    // would be a date we made up. The retrieval date is the checkable one.
    expect(EBAY_FEES_RETRIEVED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const read = new Date(`${EBAY_FEES_RETRIEVED_ON}T00:00:00Z`);
    expect(Number.isNaN(read.getTime())).toBe(false);
    expect(read.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("uses the named threshold rather than a loose 150 in the logic", () => {
    expect(ATHLETIC_SHOE_THRESHOLD).toBe(150);
    expect(skipsPerOrderFee(ATHLETIC_SHOE_THRESHOLD, "athletic-shoes")).toBe(true);
    expect(skipsPerOrderFee(ATHLETIC_SHOE_THRESHOLD - 0.01, "athletic-shoes")).toBe(false);
  });
});

function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
