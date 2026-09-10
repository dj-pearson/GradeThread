// US-3193 AC1: "matching the cost set estimateListingProfit already uses".
//
// It did not match. sourcingCeiling subtracted shipping + supplies + grading;
// estimateListingProfit subtracted cost basis + grading + shipping, with no
// supplies line at all. The ceiling was therefore stricter than the profit
// screen by one mailer, which is the safe direction and still a disagreement
// between two numbers a seller reads within a minute of each other.
//
// The two sets are now the same three lines. The DEFAULTS deliberately still
// differ and that is asserted here too, so the difference stays a decision
// rather than becoming a drift: the ceiling defaults an unset line to a real
// figure because it hands the seller a spending limit, while
// estimateListingProfit defaults an unset line to zero because it reports on
// one specific listing whose costs the caller is expected to know.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateListingProfit, priceForMargin } from "@/lib/listing-profit";

describe("estimateListingProfit carries the ceiling's third cost line", () => {
  it("subtracts supplies alongside grading and shipping", () => {
    const withSupplies = estimateListingProfit({
      price: 100,
      costBasis: 20,
      gradingCost: 2,
      shippingCost: 8.3,
      suppliesCost: 0.35,
    });
    const without = estimateListingProfit({
      price: 100,
      costBasis: 20,
      gradingCost: 2,
      shippingCost: 8.3,
    });
    expect(withSupplies.costs).toBeCloseTo(30.65, 10);
    expect(without.costs).toBeCloseTo(30.3, 10);
    expect(withSupplies.net).toBeCloseTo(without.net - 0.35, 10);
  });

  it("leaves every existing caller's number untouched when it passes none", () => {
    // Absent means zero here, exactly as it did before, so the composer and the
    // autolister drafts screen report the same figures they reported yesterday.
    expect(estimateListingProfit({ price: 100, costBasis: 20, suppliesCost: null }))
      .toEqual(estimateListingProfit({ price: 100, costBasis: 20 }));
    expect(estimateListingProfit({ price: 100, costBasis: 20, suppliesCost: 0 }))
      .toEqual(estimateListingProfit({ price: 100, costBasis: 20 }));
  });

  it("raises the margin floor by the supplies line", () => {
    // priceForMargin is the inverse; a cost it cannot see is a floor set below
    // the price that actually clears the target.
    const floor = priceForMargin({
      targetMarginPct: 30,
      costBasis: 40,
      suppliesCost: 0.35,
    });
    const blind = priceForMargin({ targetMarginPct: 30, costBasis: 40 });
    expect(floor).not.toBeNull();
    expect(blind).not.toBeNull();
    expect(floor!).toBeGreaterThan(blind!);
  });

  it("ignores a nonsense figure rather than believing it", () => {
    expect(estimateListingProfit({ price: 100, costBasis: 20, suppliesCost: -5 }))
      .toEqual(estimateListingProfit({ price: 100, costBasis: 20 }));
  });
});

describe("the two cost sets are named the same three lines", () => {
  it("every SourcingCosts line has a ProfitInputs field", () => {
    const edge = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/scout-decision.ts"),
      "utf8",
    );
    const block = /export interface SourcingCosts \{([\s\S]*?)\n\}/.exec(edge);
    expect(block, "SourcingCosts must exist").not.toBeNull();
    const lines = [...block![1]!.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]!);
    expect(lines.sort()).toEqual(["gradingCents", "shippingCents", "suppliesCents"]);

    const web = readFileSync(
      resolve(process.cwd(), "src/lib/listing-profit.ts"),
      "utf8",
    );
    for (const line of lines) {
      // shippingCents -> shippingCost, and so on. Same money, same three names.
      const field = line.replace(/Cents$/, "Cost");
      expect(web, `listing-profit.ts must carry ${field}`).toContain(`${field}?:`);
    }
  });

  it("records why the two DEFAULT to different figures", () => {
    // A divergence with no reason written down is a bug waiting to be
    // "fixed" in whichever direction the next reader guesses.
    const web = readFileSync(
      resolve(process.cwd(), "src/lib/listing-profit.ts"),
      "utf8",
    );
    expect(web).toContain("US-3193");
    expect(web.toLowerCase()).toContain("ceiling");
  });
});
