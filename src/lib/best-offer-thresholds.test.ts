import { describe, expect, it } from "vitest";
import {
  centsToDollarInput,
  dollarInputToCents,
  resolveBestOfferThresholds,
} from "./best-offer-thresholds";

// US-1898: composer prefill + clamp for Best Offer thresholds (mirrors the
// edge publish-time clamp).

const resolve = (over: Partial<Parameters<typeof resolveBestOfferThresholds>[0]>) =>
  resolveBestOfferThresholds({
    priceCents: 5000,
    p25Cents: null,
    p75Cents: null,
    acceptOverrideCents: null,
    declineOverrideCents: null,
    ...over,
  });

describe("resolveBestOfferThresholds — prefill from comp band", () => {
  it("derives accept from p75 and decline from p25", () => {
    expect(resolve({ p25Cents: 3000, p75Cents: 4500 })).toEqual({
      autoAcceptCents: 4500,
      autoDeclineCents: 3000,
    });
  });

  it("leaves both null when there is no comp band and no override", () => {
    expect(resolve({})).toEqual({ autoAcceptCents: null, autoDeclineCents: null });
  });
});

describe("resolveBestOfferThresholds — override wins", () => {
  it("prefers the seller override over the comp default", () => {
    expect(
      resolve({ p25Cents: 3000, p75Cents: 4500, acceptOverrideCents: 4000, declineOverrideCents: 2500 }),
    ).toEqual({ autoAcceptCents: 4000, autoDeclineCents: 2500 });
  });
});

describe("resolveBestOfferThresholds — clamp to eBay constraints", () => {
  it("nudges an accept at/above price to one cent under", () => {
    expect(resolve({ priceCents: 5000, acceptOverrideCents: 5000 }).autoAcceptCents).toBe(4999);
    expect(resolve({ priceCents: 5000, acceptOverrideCents: 6000 }).autoAcceptCents).toBe(4999);
  });

  it("drops an accept when the price is ≤ 1 cent (no room)", () => {
    expect(resolve({ priceCents: 1, acceptOverrideCents: 1 }).autoAcceptCents).toBeNull();
  });

  it("drops a decline that is ≥ accept", () => {
    expect(
      resolve({ acceptOverrideCents: 4000, declineOverrideCents: 4000 }).autoDeclineCents,
    ).toBeNull();
    expect(
      resolve({ acceptOverrideCents: 4000, declineOverrideCents: 4500 }).autoDeclineCents,
    ).toBeNull();
  });

  it("drops a lone decline that is ≥ the listing price", () => {
    expect(
      resolve({ priceCents: 5000, declineOverrideCents: 5000 }),
    ).toEqual({ autoAcceptCents: null, autoDeclineCents: null });
  });

  it("keeps a valid decline < accept < price", () => {
    expect(
      resolve({ priceCents: 5000, acceptOverrideCents: 4500, declineOverrideCents: 3000 }),
    ).toEqual({ autoAcceptCents: 4500, autoDeclineCents: 3000 });
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
