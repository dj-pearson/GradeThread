import { describe, expect, it } from "vitest";
import {
  centsToDollarInput,
  dollarInputToCents,
  lowAcceptWarning,
  resolveBestOfferThresholds,
} from "./best-offer-thresholds";

// US-1898: composer clamp for Best Offer thresholds (mirrors the edge
// publish-time clamp). US-2405: the seller's numbers only — no comp prefill.

const resolve = (over: Partial<Parameters<typeof resolveBestOfferThresholds>[0]>) =>
  resolveBestOfferThresholds({
    priceCents: 5000,
    acceptCents: null,
    declineCents: null,
    ...over,
  });

describe("resolveBestOfferThresholds — blank stays blank", () => {
  it("returns nothing when the seller typed nothing", () => {
    expect(resolve({})).toEqual({ autoAcceptCents: null, autoDeclineCents: null });
  });

  it("keeps the numbers the seller typed", () => {
    expect(resolve({ acceptCents: 4500, declineCents: 3000 })).toEqual({
      autoAcceptCents: 4500,
      autoDeclineCents: 3000,
    });
  });

  it("treats 0 and negatives as blank", () => {
    expect(resolve({ acceptCents: 0, declineCents: -100 })).toEqual({
      autoAcceptCents: null,
      autoDeclineCents: null,
    });
  });
});

describe("resolveBestOfferThresholds — clamp to eBay constraints", () => {
  it("nudges an accept at/above price to one cent under", () => {
    expect(resolve({ priceCents: 5000, acceptCents: 5000 }).autoAcceptCents).toBe(4999);
    expect(resolve({ priceCents: 5000, acceptCents: 6000 }).autoAcceptCents).toBe(4999);
  });

  it("drops an accept when the price is ≤ 1 cent (no room)", () => {
    expect(resolve({ priceCents: 1, acceptCents: 1 }).autoAcceptCents).toBeNull();
  });

  it("drops a decline that is ≥ accept", () => {
    expect(resolve({ acceptCents: 4000, declineCents: 4000 }).autoDeclineCents).toBeNull();
    expect(resolve({ acceptCents: 4000, declineCents: 4500 }).autoDeclineCents).toBeNull();
  });

  it("drops a lone decline that is ≥ the listing price", () => {
    expect(resolve({ priceCents: 5000, declineCents: 5000 })).toEqual({
      autoAcceptCents: null,
      autoDeclineCents: null,
    });
  });

  it("keeps a valid decline < accept < price", () => {
    expect(resolve({ priceCents: 5000, acceptCents: 4500, declineCents: 3000 })).toEqual({
      autoAcceptCents: 4500,
      autoDeclineCents: 3000,
    });
  });
});

// US-2405: eBay only checks accept < price, so a threshold left over from an
// older, much lower price passes every rule and still sells the item for a
// fraction of what it is now listed at. The warning is the only thing that
// catches it, and it warns rather than blocks — a half-price clearance is a
// legitimate choice.
describe("lowAcceptWarning", () => {
  it("fires on the reported case: $27.50 accept on a $298 listing", () => {
    const w = lowAcceptWarning(29800, 2750);
    expect(w).toContain("9%");
    expect(w).toContain("27.50");
  });

  it("stays quiet for an accept close to the price", () => {
    expect(lowAcceptWarning(29800, 27000)).toBeNull();
  });

  it("stays quiet with no accept or no price", () => {
    expect(lowAcceptWarning(29800, null)).toBeNull();
    expect(lowAcceptWarning(0, 2750)).toBeNull();
  });
});

describe("dollar ⇄ cents helpers", () => {
  it("formats cents to a dollar input, blanking null/≤0", () => {
    expect(centsToDollarInput(4599)).toBe("45.99");
    expect(centsToDollarInput(null)).toBe("");
    expect(centsToDollarInput(0)).toBe("");
  });
  it("parses a dollar input to cents, null on blank/invalid", () => {
    expect(dollarInputToCents("45.99")).toBe(4599);
    expect(dollarInputToCents("")).toBeNull();
    expect(dollarInputToCents("abc")).toBeNull();
    expect(dollarInputToCents("0")).toBeNull();
  });
});
