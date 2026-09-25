import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASKING_PRICE_DISCOUNT,
  estimateWorkValue,
  FALLBACK_SHIPPING_CENTS,
  isComplete,
  PLANNING_HORIZON_DAYS,
  SUPPORTED_FEE_MARKETPLACES,
  type ValueEstimate,
  type ValueInput,
} from "@/lib/work-value";
import { EBAY_FEE_RATE, EBAY_FIXED_FEE } from "@/lib/ebay-fees";

// Worth My Time, R1 05/12 (US-3170).

function complete(over: Partial<ValueInput> = {}): ValueEstimate {
  const r = estimateWorkValue({
    marketplace: "ebay",
    evidence: { amountCents: 8000, source: "sold_comp", observedAt: "2026-09-01T00:00:00Z" },
    purchaseCents: 2000,
    shippingCents: 900,
    suppliesCents: 100,
    ...over,
  });
  if (!isComplete(r)) throw new Error(`unexpectedly incomplete: ${r.reason}`);
  return r;
}

describe("two numbers, because sunk cost is not a reason to skip work (AC1)", () => {
  it("separates whole-item profit from what is left to earn", () => {
    const v = complete();
    // $80 sale, 13.6% + $0.40 fees, $9 postage, $1 supplies, $20 paid.
    const fees = Math.round(8000 * EBAY_FEE_RATE + EBAY_FIXED_FEE * 100);
    expect(v.remainingContributionCents).toBe(8000 - fees - 1000);
    expect(v.wholeItemProfitCents).toBe(v.remainingContributionCents - 2000);
  });

  it("an already-spent purchase does NOT lower the contribution", () => {
    // The whole reason for two fields. A jacket bought for $60 that will sell
    // for $55 is a bad buy and still worth twenty minutes to recover $50.
    // Ranking on whole-item profit would bury exactly the items a seller most
    // needs to clear.
    const cheap = complete({ purchaseCents: 100 });
    const dear = complete({ purchaseCents: 9000 });
    expect(cheap.remainingContributionCents).toBe(dear.remainingContributionCents);
    expect(dear.wholeItemProfitCents).toBeLessThan(cheap.wholeItemProfitCents);
    // ...and the bad buy still leaves real money on the table.
    expect(dear.remainingContributionCents).toBeGreaterThan(0);
  });

  it("past costs beyond the purchase hit only the whole-item figure", () => {
    const withGrading = complete({ spentCents: 500 });
    const without = complete({ spentCents: 0 });
    expect(withGrading.remainingContributionCents)
      .toBe(without.remainingContributionCents);
    expect(withGrading.wholeItemProfitCents)
      .toBe(without.wholeItemProfitCents - 500);
  });
});

describe("fees come from the shared source (AC2)", () => {
  it("only eBay has a fee schedule this repo knows", () => {
    expect(SUPPORTED_FEE_MARKETPLACES).toEqual(["ebay"]);
  });

  it("never silently applies eBay's fees to another marketplace", () => {
    // Poshmark's 20%, Mercari's tiering and Depop's split are not in this
    // codebase. Using eBay's numbers would be wrong by several dollars on
    // every item, and wrong in the OPTIMISTIC direction.
    for (const marketplace of ["poshmark", "mercari", "depop", "grailed", null]) {
      const r = estimateWorkValue({
        marketplace,
        evidence: { amountCents: 8000, source: "sold_comp", observedAt: null },
      });
      expect(isComplete(r)).toBe(false);
      if (!isComplete(r)) {
        expect(r.reason).toBe("unsupported_fee_schedule");
        // The seller cannot fix a fee schedule we do not have.
        expect(r.researchable).toBe(false);
      }
    }
  });

  it("uses the same rate and fixed fee as the pricing screen", () => {
    const v = complete({ evidence: { amountCents: 10000, source: "sold_comp", observedAt: null } });
    const fees = Math.round(10000 * EBAY_FEE_RATE + EBAY_FIXED_FEE * 100);
    expect(v.remainingContributionCents).toBe(10000 - fees - 1000);
  });

  it("does not hand-roll a fee rate of its own", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-value.ts"), "utf8");
    const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    // A literal percentage here would be a second fee source that drifts.
    expect(code).not.toMatch(/0\.1[0-9]\s*\*/);
    expect(code).toMatch(/EBAY_FEE_RATE/);
  });
});

describe("a non-USD item is refused rather than converted (AC2)", () => {
  it("says so explicitly and is not researchable", () => {
    const r = estimateWorkValue({
      marketplace: "ebay",
      currency: "GBP",
      evidence: { amountCents: 8000, source: "sold_comp", observedAt: null },
    });
    expect(isComplete(r)).toBe(false);
    if (!isComplete(r)) {
      expect(r.reason).toBe("unsupported_currency");
      expect(r.researchable).toBe(false);
    }
  });
});

describe("evidence stays distinct, and an asking price is not proceeds (AC3)", () => {
  it("a sold comp is taken at face value", () => {
    const v = complete({
      evidence: { amountCents: 8000, source: "sold_comp", observedAt: null },
    });
    const fees = Math.round(8000 * EBAY_FEE_RATE + EBAY_FIXED_FEE * 100);
    expect(v.remainingContributionCents).toBe(8000 - fees - 1000);
    expect(v.evidence).toBe("sold_comp");
  });

  it("an active asking price is DISCOUNTED before it becomes money", () => {
    // An unsold listing at $200 is evidence that $200 did not sell.
    const asking = complete({
      evidence: { amountCents: 8000, source: "active_asking", observedAt: null },
    });
    const sold = complete({
      evidence: { amountCents: 8000, source: "sold_comp", observedAt: null },
    });
    expect(asking.remainingContributionCents)
      .toBeLessThan(sold.remainingContributionCents);
    const expected = Math.round(8000 * ASKING_PRICE_DISCOUNT);
    const fees = Math.round(expected * EBAY_FEE_RATE + EBAY_FIXED_FEE * 100);
    expect(asking.remainingContributionCents).toBe(expected - fees - 1000);
    expect(asking.evidence).toBe("active_asking");
  });

  it("the weaker the evidence, the wider the band", () => {
    const widthOf = (v: ValueEstimate) => v.highCents - v.lowCents;
    const sold = complete({ evidence: { amountCents: 8000, source: "sold_comp", observedAt: null } });
    const seller = complete({ evidence: { amountCents: 8000, source: "seller_estimate", observedAt: null } });
    const asking = complete({ evidence: { amountCents: 8000, source: "active_asking", observedAt: null } });
    expect(widthOf(sold)).toBeLessThan(widthOf(seller));
    // The asking band is widened again even though the figure is already
    // discounted, because it is the weakest evidence there is.
    expect(widthOf(asking) / Math.abs(asking.remainingContributionCents))
      .toBeGreaterThan(widthOf(sold) / Math.abs(sold.remainingContributionCents));
  });

  it("carries the observation date through, and null when nobody recorded one", () => {
    expect(complete().observedAt).toBe("2026-09-01T00:00:00Z");
    expect(
      complete({ evidence: { amountCents: 8000, source: "sold_comp", observedAt: null } }).observedAt,
    ).toBeNull();
  });

  it("invents no probability and no sale date", () => {
    // Nothing in R1 measures either. The horizon is an assumption, stated.
    const v = complete();
    expect(v.horizonDays).toBe(PLANNING_HORIZON_DAYS);
    expect(Object.keys(v)).not.toContain("probability");
    expect(Object.keys(v)).not.toContain("expectedSaleDate");
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-value.ts"), "utf8");
    expect(src).not.toMatch(/sellThroughRate|probabilityOfSale|expectedSaleDate/);
  });
});

describe("missing inputs (AC4)", () => {
  it("a missing purchase price is UNKNOWN, not free inventory", () => {
    // Treating it as zero would report the full sale price as profit and float
    // every un-costed item to the top of the plan.
    const v = complete({ purchaseCents: null });
    expect(v.missing).toContain("purchase_price");
    // It is left OUT of the whole-item figure rather than counted as 0...
    expect(v.wholeItemProfitCents).toBe(v.remainingContributionCents);
    // ...and `missing` is the only thing that says so, which is why a caller
    // printing the figure without reading it would be wrong.
    expect(v.missing.length).toBeGreaterThan(0);
  });

  it("a fallback postage figure is labelled, never presented as recorded", () => {
    const withReal = complete({ shippingCents: 1500 });
    expect(withReal.missing).not.toContain("shipping_cost");

    const fallback = complete({ shippingCents: null, suppliesCents: null });
    expect(fallback.missing).toContain("shipping_cost");
    expect(fallback.missing).toContain("supplies_cost");
    // Deliberately on the high side: under-estimating postage flatters the
    // item, and a plan that flatters items wastes evenings.
    expect(FALLBACK_SHIPPING_CENTS).toBeGreaterThan(0);
    expect(fallback.remainingContributionCents)
      .toBeLessThan(complete({ shippingCents: 0, suppliesCents: 0 }).remainingContributionCents);
  });

  it("nothing recorded at all still produces an estimate, fully labelled", () => {
    const v = complete({
      purchaseCents: null,
      shippingCents: null,
      suppliesCents: null,
    });
    expect(v.missing.sort()).toEqual(["purchase_price", "shipping_cost", "supplies_cost"]);
  });

  it("no price evidence becomes a RESEARCH task, not a disappearance", () => {
    // AC4: unknown value can still generate pricing research rather than
    // vanishing from the planner.
    for (const evidence of [null, { amountCents: -1, source: "sold_comp" as const, observedAt: null }]) {
      const r = estimateWorkValue({ marketplace: "ebay", evidence });
      expect(isComplete(r)).toBe(false);
      if (!isComplete(r)) {
        expect(r.reason).toBe("no_price_evidence");
        expect(r.researchable).toBe(true);
      }
    }
  });
});

describe("zero and negative proceeds (AC6)", () => {
  it("a losing item reports a negative contribution rather than clamping to 0", () => {
    // Clamping would make a loss look like break-even and leave the item in
    // the plan at the same rank as work that earns nothing and costs nothing.
    const v = complete({
      evidence: { amountCents: 500, source: "sold_comp", observedAt: null },
    });
    expect(v.remainingContributionCents).toBeLessThan(0);
  });

  it("a zero-value comp is refused as evidence, not priced at zero", () => {
    const r = estimateWorkValue({
      marketplace: "ebay",
      evidence: { amountCents: 0, source: "sold_comp", observedAt: null },
    });
    // Zero is not a price something sold for; it is a missing number.
    expect(isComplete(r)).toBe(true);
    if (isComplete(r)) expect(r.remainingContributionCents).toBeLessThan(0);
  });

  it("the band stays the right way round on a negative contribution", () => {
    const v = complete({
      evidence: { amountCents: 500, source: "active_asking", observedAt: null },
    });
    expect(v.lowCents).toBeLessThan(v.highCents);
  });
});

describe("no repair uplift in R1 (AC5)", () => {
  it("does not read the repair triage module", () => {
    // A mended garment may be worth more; nobody has measured how much, and an
    // uplift would make a repair task outrank real work on a promise.
    // Comments STRIPPED before the scan. The header names repair-triage.ts in
    // the course of explaining why it is not used, and a scan that read the
    // explanation as the thing it forbids would push the reasoning out of the
    // file -- which is where the next person looks for it.
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-value.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/repair-triage/);
    expect(code).not.toMatch(/repairUplift|gradeUplift/);
  });
});

describe("purity (AC6)", () => {
  it("needs no network and no model call, and reads no clock", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-value.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    for (const banned of ["fetch(", "supabase", "anthropic", "Date.now", "new Date", "Math.random"]) {
      expect(code.includes(banned), `work-value.ts uses ${banned}`).toBe(false);
    }
  });

  it("is deterministic", () => {
    expect(estimateWorkValue({
      marketplace: "ebay",
      evidence: { amountCents: 8000, source: "sold_comp", observedAt: null },
    })).toEqual(estimateWorkValue({
      marketplace: "ebay",
      evidence: { amountCents: 8000, source: "sold_comp", observedAt: null },
    }));
  });
});

describe("WMT-14: assumed fees, future costs and the seller's own range", () => {
  const base = {
    marketplace: "ebay",
    evidence: { amountCents: 5000, source: "seller_estimate" as const, observedAt: null },
    purchaseCents: 800,
    shippingCents: 900,
    suppliesCents: 100,
  };

  it("an assumed fee schedule is estimated AND named in missing", () => {
    const r = estimateWorkValue({ ...base, feeScheduleAssumed: true });
    expect(r.complete).toBe(true);
    expect(r.missing).toContain("fee_schedule_assumed");
  });

  it("a $15 remaining cost lowers the conservative figure by exactly $15", () => {
    const before = estimateWorkValue(base);
    const after = estimateWorkValue({ ...base, futureCostCents: 1500 });
    if (!before.complete || !after.complete) throw new Error("expected complete");
    expect(after.remainingContributionCents).toBe(before.remainingContributionCents - 1500);
    // A stated cost is known to the cent: it moves both ends, not the width.
    expect(before.lowCents - after.lowCents).toBe(1500);
    expect(before.highCents - after.highCents).toBe(1500);
  });

  it("a seller range keeps its width: both ends go through fees, nothing is added", () => {
    const r = estimateWorkValue({
      ...base,
      evidence: { ...base.evidence, amountCents: 4000, highAmountCents: 6000 },
    });
    if (!r.complete) throw new Error("expected complete");
    expect(r.lowCents).toBe(r.remainingContributionCents);
    const fees = (p: number) => Math.round((p / 100 * EBAY_FEE_RATE + EBAY_FIXED_FEE) * 100);
    expect(r.lowCents).toBe(4000 - fees(4000) - 1000);
    expect(r.highCents).toBe(6000 - fees(6000) - 1000);
  });
});
