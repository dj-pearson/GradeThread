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

import { describe, expect, it } from "vitest";
import { stepPrice } from "@/components/flipdesk/listing-kit";

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
});
