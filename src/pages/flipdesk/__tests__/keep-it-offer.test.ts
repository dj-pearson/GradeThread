// US-2932: the keep-it suggestion.
//
// The number is attached to a button that moves money, so the rules that matter
// most are the ones about REFUSING to produce one. A suggestion built on an
// unknown cost basis is a confident figure with nothing behind it, and a seller
// reading "$14" has no way to tell it apart from one that was computed.
import { describe, it, expect } from "vitest";
import {
  ESTIMATED_RETURN_SHIPPING_CENTS,
  suggestKeepItRefund,
} from "@/pages/flipdesk/keep-it-offer";

describe("suggestKeepItRefund", () => {
  it("suggests 60 percent of what a return would cost, rounded down to dollars", () => {
    // Sold $60, cost $20, return shipping $8 → the ceiling is $48, so 60% is
    // $28.80, floored to $28.
    const out = suggestKeepItRefund({
      salePriceCents: 6000,
      acquiredPriceCents: 2000,
      returnShippingCents: 800,
    });
    expect(out).not.toBeNull();
    expect(out!.ceilingCents).toBe(4800);
    expect(out!.suggestedCents).toBe(2800);
  });

  it("defaults the shipping estimate rather than inventing a rate per call", () => {
    const out = suggestKeepItRefund({ salePriceCents: 6000, acquiredPriceCents: 2000 });
    expect(out!.returnShippingCents).toBe(ESTIMATED_RETURN_SHIPPING_CENTS);
  });

  it("refuses when the cost basis is unknown", () => {
    // The important refusal. Without a cost there is no ceiling, and a number
    // produced anyway is a guess wearing a decision's clothes.
    expect(suggestKeepItRefund({ salePriceCents: 6000, acquiredPriceCents: null })).toBeNull();
    expect(suggestKeepItRefund({ salePriceCents: null, acquiredPriceCents: 2000 })).toBeNull();
  });

  it("refuses when the item is worth more back than any discount saves", () => {
    // Sold $30, cost $50: taking the return is the better outcome, and a token
    // partial would leave the seller worse off.
    expect(
      suggestKeepItRefund({
        salePriceCents: 3000,
        acquiredPriceCents: 5000,
        returnShippingCents: 800,
      }),
    ).toBeNull();
  });

  it("never suggests the whole sale", () => {
    // A full refund through the partial path leaves the return sitting OPEN,
    // which is a different and worse outcome than closing it.
    const out = suggestKeepItRefund({
      salePriceCents: 1000,
      acquiredPriceCents: 0,
      returnShippingCents: 5000,
    })!;
    expect(out.suggestedCents).toBeLessThan(1000);
    expect(out.suggestedCents).toBeGreaterThan(0);
  });

  it("refuses on junk numbers rather than returning NaN", () => {
    expect(
      suggestKeepItRefund({ salePriceCents: Number.NaN, acquiredPriceCents: 100 }),
    ).toBeNull();
    expect(suggestKeepItRefund({ salePriceCents: 0, acquiredPriceCents: 0 })).toBeNull();
    expect(suggestKeepItRefund({ salePriceCents: -500, acquiredPriceCents: 100 })).toBeNull();
  });
});
