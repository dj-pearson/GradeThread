// US-2325 AC3: the eBay fee model has one home, and the copies cannot drift.
//
// Before this, three files carried their own fee constants with TWO different
// values — the composer's forward profit estimate used 13.25% + $0.40, and both
// ScoutAI paths used a flat 13% with no fixed fee. Nothing tied them together,
// so ScoutAI's buy/skip verdict and the profit screen the seller landed on next
// disagreed on every item, always in the same direction: ScoutAI was the
// optimistic one.
//
// Two things are guarded here, and the second is the one that decays:
//   1. the maths, so a refactor cannot quietly change what a fee is;
//   2. the EDGE MIRROR, byte for byte. The Deno runtime cannot import from the
//      Vite `src/` tree, so the file is duplicated — and a duplicated constant
//      with no guard is precisely the shape that produced this bug.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EBAY_FEE_RATE,
  EBAY_FIXED_FEE,
  EBAY_FEE_SOURCE,
  ebayFeesFor,
  ebayNetProceeds,
  ebayNetProceedsCents,
} from "../ebay-fees";
import { finalValueFee } from "../ebay-fee-schedule";

const CANONICAL = resolve(process.cwd(), "src/lib/ebay-fees.ts");
const EDGE_MIRROR = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/ebay-fees.ts",
);

describe("edge mirror stays in sync (US-2325)", () => {
  it("the services/edge-functions copy is byte-identical", () => {
    expect(readFileSync(EDGE_MIRROR, "utf8")).toBe(
      readFileSync(CANONICAL, "utf8"),
    );
  });

  it("no consumer redefines a fee number of its own", () => {
    // The actual regression: a file re-declaring its own rate. Catching the
    // DECLARATION is what matters — the old ScoutAI constants type-checked,
    // passed their tests, and were wrong only in relation to another file.
    for (
      const file of [
        "services/edge-functions/src/lib/scout-scoring.ts",
        "services/edge-functions/src/lib/scout-decision.ts",
        "src/lib/listing-profit.ts",
      ]
    ) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(
        src,
        `${file} declares its own fee literal again — it must read ebay-fees`,
      ).not.toMatch(/=\s*0\.1[0-9]{1,3}\s*;/);
      expect(src).toMatch(/ebay-fees/);
    }
  });
});

describe("the fee model itself", () => {
  it("charges the rate AND the fixed per-order fee", () => {
    // $100 → $13.60 + $0.40. Dropping either term is the bug that shipped.
    expect(ebayFeesFor(100)).toBeCloseTo(13.6 + 0.4, 10);
    expect(ebayNetProceeds(100)).toBeCloseTo(100 - 14.0, 10);
  });

  it("uses the apparel rate eBay actually publishes (US-9003)", () => {
    // Corrected from 0.1325, which is the Coins & Paper Money and trading-card
    // rate, not apparel. Read off eBay id=4822 on 2026-08-18; the working is in
    // docs/seo/ebay-fee-schedule-CONFIRMED.csv. Asserted as a literal here on
    // purpose: this is the number the whole model rests on, and a test that
    // reads it back from the constant would have passed on the wrong one too.
    expect(EBAY_FEE_RATE).toBe(0.136);
    expect(EBAY_FEE_SOURCE.lastVerified).toBe("2026-08");
  });

  it("agrees with the public calculator on the headline apparel rate", () => {
    // src/lib/ebay-fee-schedule.ts models every category shape and store tier
    // and is NOT mirrored to the edge; this blended model is. They are allowed
    // to differ in detail and must not differ on the number a seller sees most.
    const onOneHundred = finalValueFee(100, "apparel", "none").amount;
    expect(onOneHundred).toBeCloseTo(100 * EBAY_FEE_RATE, 10);
  });

  it("the fixed fee matters most on cheap items", () => {
    // The reason ScoutAI's omission was not cosmetic: a sourcing tool surfaces
    // cheap items, and $0.40 on a $12 sale is another 3.3% on top of the rate.
    const effective = ebayFeesFor(12) / 12;
    expect(effective).toBeGreaterThan(EBAY_FEE_RATE + 0.03);
  });

  it("never returns a negative net, and treats junk input as zero", () => {
    // A fee cannot pay the seller. Below the fixed fee the net floors at 0
    // rather than going negative and inverting a margin comparison.
    expect(ebayNetProceeds(0.1)).toBe(0);
    expect(ebayNetProceeds(0)).toBe(0);
    expect(ebayNetProceeds(-5)).toBe(0);
    expect(ebayNetProceeds(Number.NaN)).toBe(0);
    expect(ebayNetProceedsCents(Number.NaN)).toBe(0);
    expect(ebayNetProceedsCents(10)).toBe(0);
  });

  it("rounds the cents fee UP, against the seller's optimism", () => {
    // 1234 * 0.136 = 167.824 → 168, + 40 fixed = 208.
    expect(ebayNetProceedsCents(1234)).toBe(1234 - (168 + 40));
  });

  it("agrees with the dollar path", () => {
    // The two must not diverge; a decision engine on one and a display on the
    // other is how this story started.
    for (const dollars of [12, 45.5, 80, 250]) {
      const cents = ebayNetProceedsCents(Math.round(dollars * 100));
      expect(Math.abs(cents / 100 - ebayNetProceeds(dollars))).toBeLessThan(0.02);
    }
  });

  it("carries its provenance", () => {
    // A number with no source is a number nobody dares change. eBay moves these
    // without notice, so the note and date are part of the contract.
    expect(EBAY_FEE_SOURCE.sourceNote.length).toBeGreaterThan(40);
    expect(EBAY_FEE_SOURCE.lastVerified).toMatch(/^\d{4}-\d{2}$/);
    expect(EBAY_FEE_RATE).toBeGreaterThan(0.1);
    expect(EBAY_FEE_RATE).toBeLessThan(0.16);
    expect(EBAY_FIXED_FEE).toBeGreaterThanOrEqual(0);
    expect(EBAY_FIXED_FEE).toBeLessThan(1);
  });
});
