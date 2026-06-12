import { describe, expect, it } from "vitest";
import {
  DEFAULT_EBAY_FEE_RATE,
  DEFAULT_EBAY_FIXED_FEE,
  estimateListingProfit,
  priceForMargin,
} from "./listing-profit";

describe("estimateListingProfit", () => {
  it("returns zeros for a zero price", () => {
    expect(estimateListingProfit({ price: 0, costBasis: 20 })).toEqual({
      fees: 0,
      costs: 20,
      net: -20,
      marginPct: 0,
    });
  });

  it("applies the default eBay fee + fixed fee and cost basis", () => {
    const r = estimateListingProfit({ price: 100, costBasis: 20 });
    // 100 * 0.1325 + 0.40 = 13.65 fees; costs 20; net 66.35
    expect(r.fees).toBeCloseTo(13.65, 2);
    expect(r.costs).toBe(20);
    expect(r.net).toBeCloseTo(66.35, 2);
    expect(r.marginPct).toBeCloseTo(66.35, 2);
  });

  it("folds in grading + shipping costs", () => {
    const r = estimateListingProfit({
      price: 50,
      costBasis: 10,
      gradingCost: 3,
      shippingCost: 6,
    });
    const fees = 50 * DEFAULT_EBAY_FEE_RATE + DEFAULT_EBAY_FIXED_FEE;
    expect(r.costs).toBe(19);
    expect(r.net).toBeCloseTo(50 - fees - 19, 2);
  });

  it("can go negative when costs exceed the price", () => {
    const r = estimateListingProfit({ price: 10, costBasis: 40 });
    expect(r.net).toBeLessThan(0);
    expect(r.marginPct).toBeLessThan(0);
  });

  it("honors overridden fee rate + fixed fee", () => {
    const r = estimateListingProfit({ price: 100, feeRate: 0.1, fixedFee: 0 });
    expect(r.fees).toBeCloseTo(10, 2);
  });

  it("clamps negative/nullish inputs to zero", () => {
    const r = estimateListingProfit({
      price: 100,
      costBasis: null,
      gradingCost: undefined,
      shippingCost: -5,
    });
    expect(r.costs).toBe(0);
  });

  it("exposes sensible default constants", () => {
    expect(DEFAULT_EBAY_FEE_RATE).toBeGreaterThan(0.1);
    expect(DEFAULT_EBAY_FEE_RATE).toBeLessThan(0.16);
    expect(DEFAULT_EBAY_FIXED_FEE).toBeGreaterThanOrEqual(0);
  });
});

describe("priceForMargin", () => {
  it("returns a price whose forward margin matches the target", () => {
    const price = priceForMargin({ targetMarginPct: 25, costBasis: 20 });
    expect(price).not.toBeNull();
    const { marginPct } = estimateListingProfit({ price: price!, costBasis: 20 });
    expect(marginPct).toBeCloseTo(25, 4);
  });

  it("folds in grading + shipping costs", () => {
    const price = priceForMargin({
      targetMarginPct: 30,
      costBasis: 10,
      gradingCost: 3,
      shippingCost: 6,
    });
    const { marginPct } = estimateListingProfit({
      price: price!,
      costBasis: 10,
      gradingCost: 3,
      shippingCost: 6,
    });
    expect(marginPct).toBeCloseTo(30, 4);
  });

  it("returns null when fee rate + margin meet or exceed 100%", () => {
    expect(priceForMargin({ targetMarginPct: 90, feeRate: 0.1325 })).toBeNull();
    expect(priceForMargin({ targetMarginPct: 100 })).toBeNull();
  });

  it("clamps nullish costs to zero", () => {
    const price = priceForMargin({
      targetMarginPct: 50,
      costBasis: null,
      feeRate: 0,
      fixedFee: 0,
    });
    // With no costs/fees, any positive price yields 100% margin, so the floor
    // for a 50% target is 0.
    expect(price).toBeCloseTo(0, 6);
  });
});
