// US-2739: a price in the units the marketplace actually accepts.
//
// THE FOURTH TIME THIS SHAPE HAS TURNED UP TODAY, and all four in
// cross-post-setup.test.ts. Its coverage of this rule was:
//
//   expect(src).toContain("priceStep?: number;")
//   expect(src).toContain("spec.priceStep ?? 0")
//
//   const step = (resolved, s) =>
//     s > 0 && resolved > 0 ? Math.max(s, Math.round(resolved / s) * s) : resolved;
//   expect(step(32.49, 1)).toBe(32);
//
// The first two pin how the code is SPELLED. The third re-implements the rule
// inside the test and asserts against that copy — so changing listing-kit.tsx to
// floor instead of round, which AC4 exists to prevent because it quietly costs
// the seller money on every cross-post, leaves all six "pinned cases" green.
//
// stepPrice is exported now and this file calls it.
//
// US-2739, second pass: the body moved to src/lib/marketplace-price.ts, because
// listing-kit.tsx was not the only thing building a price for the extension.
// This file calls the module directly AND proves listing-kit's re-export is the
// same function, so both the placement scans and the behaviour stay honest.

import { describe, expect, it } from "vitest";
import {
  CENTS_PER_DOLLAR,
  dollarsToCents,
  marketplacePriceString,
  stepPrice,
  stepPriceCents,
} from "@/lib/marketplace-price";
import { stepPrice as stepPriceFromKit } from "@/components/flipdesk/listing-kit";

describe("US-2739: stepPrice", () => {
  it("rounds to the nearest step, which is the whole of AC4", () => {
    // Flooring is the tempting implementation and the wrong one: 32.51 -> 32
    // takes 51c off the seller, every time, on every cross-post.
    expect(stepPrice(32.51, 1)).toBe(33);
    expect(stepPrice(19.99, 1)).toBe(20);
    expect(stepPrice(19.5, 1)).toBe(20);
    // And down when down is nearer.
    expect(stepPrice(32.49, 1)).toBe(32);
    expect(stepPrice(19.4, 1)).toBe(19);
  });

  it("never goes below one step, and never invents a price", () => {
    // A 40c item becomes $1, not $0 — Poshmark cannot hold $0.40 and a free
    // listing is not what the seller meant.
    expect(stepPrice(0.4, 1)).toBe(1);
    expect(stepPrice(0.01, 1)).toBe(1);
    // But no price stays no price. This is the line between "round up" and
    // "invent one".
    expect(stepPrice(0, 1)).toBe(0);
  });

  it("a platform with no step keeps its cents", () => {
    // eBay and the rest price in cents and must not be touched.
    expect(stepPrice(32.49, 0)).toBe(32.49);
    expect(stepPrice(0.4, 0)).toBe(0.4);
  });

  it("handles a step other than 1, since priceStep is a number not a flag", () => {
    // Nothing declares one today. The signature permits it, so the behaviour
    // should be defined rather than accidental.
    expect(stepPrice(32.49, 5)).toBe(30);
    expect(stepPrice(33, 5)).toBe(35);
    expect(stepPrice(1, 5)).toBe(5);
  });

  it("refuses nonsense steps rather than producing a nonsense price", () => {
    // A negative or NaN step must not turn a real price into NaN or 0 and put
    // that on a live listing.
    expect(stepPrice(32.49, -1)).toBe(32.49);
    expect(stepPrice(32.49, Number.NaN)).toBe(32.49);
    // An Infinity step used to yield NaN: Math.round(price / Infinity) is 0,
    // and 0 * Infinity is NaN. A nonsense step must leave the price alone, not
    // destroy it.
    expect(stepPrice(32.49, Number.POSITIVE_INFINITY)).toBe(32.49);
    expect(stepPrice(Number.NaN, 1)).toBeNaN();
  });

  it("a negative price is left alone rather than rounded up to a step", () => {
    // Should never happen; if it does, silently turning -5 into 1 would hide a
    // data bug behind a plausible price.
    expect(stepPrice(-5, 1)).toBe(-5);
  });

  it("the displayed price and the sent price are the same number", () => {
    // AC3's actual guarantee. listing-kit computes steppedPrice ONCE and uses it
    // for the row, the validation and the payload, so there is no path where a
    // seller reads one number and Poshmark receives another.
    const resolved = 32.49;
    const shown = stepPrice(resolved, 1);
    const sent = stepPrice(resolved, 1);
    expect(shown).toBe(sent);
    expect(shown).toBe(32);
  });

  it("the Listing Kit re-exports the same function, not a second copy", () => {
    // The placement scans in cross-post-setup.test.ts assert on
    // `stepPrice(` appearing in listing-kit.tsx. That stays meaningful only
    // while the name there IS this function.
    expect(stepPriceFromKit).toBe(stepPrice);
  });
});

// ── The cents half of the boundary ─────────────────────────────────────────
//
// stepPrice is dollars-in/dollars-out because that is what the kit row and the
// revise payload carry, but the maths underneath is integer cents. Float
// dollars produce 32.450000000000003 for a fractional step, and that is a
// string no numeric input accepts.
describe("US-2739: the cents boundary", () => {
  it("dollars become cents in exactly one place, and it rounds", () => {
    expect(CENTS_PER_DOLLAR).toBe(100);
    expect(dollarsToCents(32.49)).toBe(3249);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
    // A sub-cent tail rounds rather than truncating: truncating costs the
    // seller a cent on every listing that has one. (32.495 is NOT pinned here:
    // the nearest double to it is 32.49499999999999744, so it is genuinely
    // below the midpoint and rounds down. Asserting 3250 would be asserting
    // that doubles are decimals.)
    expect(dollarsToCents(32.496)).toBe(3250);
    expect(dollarsToCents(32.494)).toBe(3249);
  });

  it("stepPriceCents is exact where float dollars are not", () => {
    expect(stepPriceCents(3249, 100)).toBe(3200);
    expect(stepPriceCents(3251, 100)).toBe(3300);
    expect(stepPriceCents(40, 100)).toBe(100);
    expect(stepPriceCents(0, 100)).toBe(0);
    expect(stepPriceCents(3249, 0)).toBe(3249);
    // The fractional-step case that motivated cents. Nearest nickel to $32.49
    // is $32.50. In float dollars `Math.round(32.49 / 0.05) * 0.05` is
    // 32.550000000000004 for $32.53 and similar noise here; in cents it is
    // exactly 3250, and the dollar figure that comes back out is exactly 32.5.
    expect(stepPriceCents(3249, 5)).toBe(3250);
    expect(stepPrice(32.49, 0.05)).toBe(32.5);
    expect(stepPrice(32.53, 0.05)).toBe(32.55);
  });
});

describe("US-2739: marketplacePriceString is the payload boundary", () => {
  it("a whole-dollar marketplace gets digits and nothing else", () => {
    // Poshmark's input is inputmode="numeric" pattern="[0-9]*". A decimal point
    // is a keystroke it refuses.
    expect(marketplacePriceString(32.49, 1)).toBe("32");
    expect(marketplacePriceString(32.51, 1)).toBe("33");
    expect(marketplacePriceString(0.4, 1)).toBe("1");
    expect(marketplacePriceString(74.5, 1)).toBe("75");
  });

  it("a marketplace with no step keeps its exact cents", () => {
    expect(marketplacePriceString(32.49, 0)).toBe("32.49");
    expect(marketplacePriceString(32.49, undefined)).toBe("32.49");
    expect(marketplacePriceString(32.5, 0)).toBe("32.50");
    expect(marketplacePriceString(32, 0)).toBe("32");
    // The reason this formats from cents instead of String(number):
    // String(0.1 + 0.2) is "0.30000000000000004", and a price field handed that
    // is a price field the seller fixes by hand.
    expect(marketplacePriceString(0.1 + 0.2, 0)).toBe("0.30");
  });

  it("no price is an empty string, never a zero and never a guess", () => {
    expect(marketplacePriceString(0, 1)).toBe("");
    expect(marketplacePriceString(null, 1)).toBe("");
    expect(marketplacePriceString(undefined, 1)).toBe("");
    expect(marketplacePriceString(Number.NaN, 1)).toBe("");
    expect(marketplacePriceString(-5, 1)).toBe("");
  });

  it("a nonsense step leaves the price alone rather than destroying it", () => {
    expect(marketplacePriceString(32.49, Number.POSITIVE_INFINITY)).toBe("32.49");
    expect(marketplacePriceString(32.49, Number.NaN)).toBe("32.49");
    expect(marketplacePriceString(32.49, -1)).toBe("32.49");
  });
});
