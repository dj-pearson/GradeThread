import { describe, it, expect } from "vitest";
import {
  COMPARISON_ORDER,
  MARKETPLACE_FEES,
  compareMarketplaces,
  comparePagePath,
  quoteMarketplace,
  type SaleInput,
} from "../marketplace-fee-schedules";

// One sale, run through all five. $40 item, $8 shipping charged, $3 tax
// collected, $12 cost of goods, $6.50 of postage actually paid.
const SALE: SaleInput = {
  itemPrice: 40,
  shippingCharged: 8,
  salesTax: 3,
  itemCost: 12,
  shippingCost: 6.5,
};

describe("worked examples, hand-computed", () => {
  it("Poshmark: 20% of the item price only, nothing else", () => {
    const q = quoteMarketplace("poshmark", SALE);
    // 40 * 0.20 = 8.00. No processing fee, no listing fee.
    expect(q.totalFees).toBe(8);
    expect(q.lines).toHaveLength(1);
    // 40 + 8 - 8 = 40.00 paid out. Tax is never in the payout.
    expect(q.payout).toBe(40);
    // 40 - 12 - 6.50 = 21.50
    expect(q.profit).toBe(21.5);
  });

  it("Poshmark: the flat fee below $15 is worse than the percentage", () => {
    const q = quoteMarketplace("poshmark", { itemPrice: 10, shippingCharged: 0, salesTax: 0 });
    expect(q.totalFees).toBe(2.95);
    // 29.5% of the item price, against the 20% a $15 sale pays.
    expect(q.effectiveRatePct).toBe(29.5);
    expect(q.lines[0]!.label).toBe("Flat commission");
  });

  it("Mercari: 10% of item plus buyer-paid shipping, no processing fee", () => {
    const q = quoteMarketplace("mercari", SALE);
    // (40 + 8) * 0.10 = 4.80
    expect(q.totalFees).toBe(4.8);
    expect(q.lines).toHaveLength(1);
    expect(q.payout).toBe(43.2);
    // The buyer pays 3.6% of 48 on top: 1.73. Not the seller's cost.
    expect(q.buyerPays).toBe(1.73);
  });

  it("Depop: no selling fee, 3.3% + $0.45 on item plus shipping plus tax", () => {
    const q = quoteMarketplace("depop", SALE);
    // (40 + 8 + 3) * 0.033 = 1.683 -> 1.68, plus 0.45 = 2.13
    expect(q.totalFees).toBe(2.13);
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0]!.label).toBe("Payment processing");
    expect(q.payout).toBe(45.87);
    // Buyer pays up to 5% of 48 plus up to $1 = 3.40
    expect(q.buyerPays).toBe(3.4);
  });

  it("Depop: boosting costs 12%, more than most platforms charge to sell", () => {
    const q = quoteMarketplace("depop", { ...SALE, promoted: true });
    // 2.13 processing + 40 * 0.12 = 4.80 boost = 6.93
    expect(q.totalFees).toBe(6.93);
    expect(q.lines.some((l) => l.label === "Boosted Listings")).toBe(true);
  });

  it("Etsy: 6.5% of item plus shipping, 3% + $0.25 processing, $0.20 listing", () => {
    const q = quoteMarketplace("etsy", SALE);
    // (40 + 8) * 0.065 = 3.12
    // (40 + 8) * 0.03 = 1.44, plus 0.25 = 1.69
    // listing 0.20
    // total 5.01
    expect(q.totalFees).toBe(5.01);
    expect(q.lines).toHaveLength(3);
    expect(q.payout).toBe(42.99);
  });

  it("Etsy: Offsite Ads at 15% nearly doubles the bill", () => {
    const q = quoteMarketplace("etsy", { ...SALE, promoted: true });
    // 5.01 + (40 + 8) * 0.15 = 7.20 -> 12.21
    expect(q.totalFees).toBe(12.21);
  });

  it("eBay: delegates to the real eBay schedule rather than a second copy", () => {
    const q = quoteMarketplace("ebay", SALE);
    // Apparel at 13.6% of the 51.00 sale total is 6.94, plus the $0.40
    // per-order fee. eBay is the only one of the five charging on sales tax.
    expect(q.totalFees).toBeCloseTo(7.34, 2);
    expect(q.lines.some((l) => l.label === "Final value fee")).toBe(true);
    expect(q.payout).toBeCloseTo(40.66, 2);
  });
});

describe("cross-platform comparison", () => {
  it("covers all five and sorts by payout", () => {
    const rows = compareMarketplaces(SALE);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.key))).toEqual(new Set(COMPARISON_ORDER));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.payout).toBeGreaterThanOrEqual(rows[i]!.payout);
    }
  });

  it("puts Depop top and Poshmark bottom on this sale", () => {
    const rows = compareMarketplaces(SALE);
    expect(rows[0]!.key).toBe("depop");
    expect(rows[rows.length - 1]!.key).toBe("poshmark");
  });

  it("the spread between best and worst is real money on a $40 item", () => {
    const rows = compareMarketplaces(SALE);
    const spread = rows[0]!.payout - rows[rows.length - 1]!.payout;
    expect(spread).toBeCloseTo(5.87, 2);
  });

  it("never links to a /compare/ page that does not exist", () => {
    expect(comparePagePath("poshmark", "mercari")).toBe("/compare/poshmark-vs-mercari");
    // Published the other way round; the function finds it either way.
    expect(comparePagePath("ebay", "mercari")).toBe("/compare/mercari-vs-ebay");
    // No etsy comparison page has been published.
    expect(comparePagePath("etsy", "depop")).toBeNull();
  });
});

describe("schedule integrity", () => {
  it("every platform names its own fee page as the source", () => {
    for (const key of COMPARISON_ORDER) {
      const s = MARKETPLACE_FEES[key];
      expect(s.source).toMatch(/^https:\/\//);
      expect(s.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (s.effectiveFrom !== null) expect(s.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.gotcha.length).toBeGreaterThan(40);
    }
  });

  it("matches the confirmed rates in docs/seo/marketplace-fees-CONFIRMED.csv", () => {
    // Sentinels. A rate edit without a source trips one of these.
    expect(MARKETPLACE_FEES.poshmark.commissionRate).toBe(0.2);
    expect(MARKETPLACE_FEES.poshmark.smallOrderFlatFee).toEqual({ under: 15, fee: 2.95 });
    expect(MARKETPLACE_FEES.mercari.commissionRate).toBe(0.1);
    expect(MARKETPLACE_FEES.mercari.buyerFee?.rate).toBe(0.036);
    expect(MARKETPLACE_FEES.depop.commissionRate).toBe(0);
    expect(MARKETPLACE_FEES.depop.processingRate).toBe(0.033);
    expect(MARKETPLACE_FEES.depop.processingFixed).toBe(0.45);
    expect(MARKETPLACE_FEES.depop.promotionRate).toBe(0.12);
    expect(MARKETPLACE_FEES.etsy.commissionRate).toBe(0.065);
    expect(MARKETPLACE_FEES.etsy.processingRate).toBe(0.03);
    expect(MARKETPLACE_FEES.etsy.processingFixed).toBe(0.25);
    expect(MARKETPLACE_FEES.etsy.listingFee).toBe(0.2);
  });

  it("only eBay charges on sales tax, which is the comparison's whole point", () => {
    const taxed = COMPARISON_ORDER.filter(
      (k) => MARKETPLACE_FEES[k].commissionBase === "item-plus-shipping-plus-tax",
    );
    expect(taxed).toEqual(["ebay"]);
  });
});
