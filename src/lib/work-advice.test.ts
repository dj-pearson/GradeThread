// US-3180: when should a seller stop working on an item?
//
// AC6 names eight cases and the through-line is that most of them are
// situations where the honest answer is a question rather than a
// recommendation. The one that matters most is the expensive past purchase:
// the maths must NOT be changed by what the seller already paid.

import { describe, it, expect } from "vitest";
import {
  ADVICE_OPTIONS,
  LOW_VALUE_FLOOR_CENTS,
  REASON_CODES,
  adviseOnItem,
  type AdviceInput,
} from "@/lib/work-advice";
import type { ValueEstimate, ValueResult } from "@/lib/work-value";
import type { DefectFound } from "@/types/database";

function value(over: Partial<ValueEstimate> = {}): ValueEstimate {
  return {
    complete: true,
    wholeItemProfitCents: 2000,
    remainingContributionCents: 4200,
    lowCents: 3600,
    highCents: 4800,
    evidence: "sold_comp",
    observedAt: "2026-09-01T00:00:00.000Z",
    missing: [],
    horizonDays: 30,
    ...over,
  };
}

function advise(over: Partial<AdviceInput> = {}) {
  return adviseOnItem({
    value: value(),
    remainingMinutes: 12,
    remainingCostCents: 300,
    ...over,
  });
}

function pick(result: ReturnType<typeof advise>, option: string) {
  return result.alternatives.find((a) => a.option === option);
}

/** A repairable defect: a loose seam the grader flagged as fixable. */
const REPAIRABLE: DefectFound = {
  defect_type: "seam",
  severity: "moderate",
  size_bucket: "small",
  repairability: "repairable",
  area_pct: null,
} as unknown as DefectFound;

const PERMANENT: DefectFound = {
  defect_type: "stain",
  severity: "severe",
  size_bucket: "large",
  repairability: "permanent",
  area_pct: null,
} as unknown as DefectFound;

describe("sunk cost never decides (AC1)", () => {
  it("an expensive past purchase does not change the comparison", () => {
    // THE CASE THIS FEATURE EXISTS FOR. The same garment, bought for $80 and
    // bought for $4. What is left to gain from here is identical, so the
    // recommendation must be identical.
    const cheap = advise({ value: value({ wholeItemProfitCents: 3000 }) });
    const dear = advise({ value: value({ wholeItemProfitCents: -6000 }) });
    expect(dear.recommended).toBe(cheap.recommended);
    expect(pick(dear, "continue_prep")!.futureContributionCents)
      .toBe(pick(cheap, "continue_prep")!.futureContributionCents);
  });

  it("the total is still reported, BESIDE the comparison", () => {
    // Hidden would look like concealment, and a seller deciding what to buy
    // next needs it.
    const r = advise({ value: value({ wholeItemProfitCents: -6000 }) });
    expect(r.wholeItemProfitCents).toBe(-6000);
    // And it is nowhere in the alternatives, which are future-only.
    for (const a of r.alternatives) {
      expect(a.futureContributionCents).not.toBe(-6000);
    }
  });

  it("an unrecorded purchase price gives no total, rather than zero", () => {
    const r = advise({
      value: value({ missing: ["purchase_price"], wholeItemProfitCents: 4200 }),
    });
    // Unknown is not free. Reporting the profit as if the garment were free
    // would flatter every un-costed item.
    expect(r.wholeItemProfitCents).toBeNull();
  });
});

describe("profitable remaining work (AC6)", () => {
  it("recommends continuing when the remaining work clears its own cost", () => {
    const r = advise({ remainingMinutes: 12, remainingCostCents: 300 });
    expect(r.recommended).toBe("continue_prep");
    expect(pick(r, "continue_prep")!.reasons).toContain("contribution_beats_alternatives");
    expect(r.uncertain).toBe(false);
  });

  it("the hourly target is charged against the remaining minutes", () => {
    const withTarget = advise({ hourlyTargetCents: 3000, remainingMinutes: 60 });
    const without = advise({ hourlyTargetCents: null, remainingMinutes: 60 });
    // An hour at $30 is $30 off the contribution.
    expect(pick(withTarget, "continue_prep")!.futureContributionCents)
      .toBe(pick(without, "continue_prep")!.futureContributionCents! - 3000);
  });

  it("with no target, time costs nothing and that is recorded", () => {
    const r = advise({ hourlyTargetCents: null });
    expect(r.assumptions.hourlyTargetCents).toBeNull();
    // 4200 - 300, with no time charge.
    expect(pick(r, "continue_prep")!.futureContributionCents).toBe(3900);
  });
});

describe("poor-value extra work (AC6)", () => {
  it("says so when the remaining work costs more than it returns", () => {
    const r = advise({
      value: value({ remainingContributionCents: 200, lowCents: 150, highCents: 250 }),
      remainingCostCents: 900,
    });
    expect(pick(r, "continue_prep")!.reasons)
      .toContain("remaining_work_costs_more_than_it_returns");
    // ⚠ NOT "recommended: sell_as_is". Nothing has measured what a
    // half-prepped garment fetches, so the model says finishing is not worth
    // it and shows the alternatives, rather than recommending one it cannot
    // price. Recommending the unpriced option would be exactly the
    // fabrication this file refuses everywhere else.
    expect(r.recommended).toBeNull();
    expect(pick(r, "sell_as_is")!.futureContributionCents).toBeNull();
    expect(pick(r, "sell_as_is")!.reasons).toContain("as_is_price_unmeasured");
  });

  it("names the hourly target when that is what fails", () => {
    const r = advise({
      value: value({ remainingContributionCents: 1000, lowCents: 900, highCents: 1100 }),
      remainingCostCents: 0,
      remainingMinutes: 120,
      hourlyTargetCents: 3000,
    });
    // Two hours at $30 against $10 of value left.
    expect(pick(r, "continue_prep")!.reasons).toContain("below_hourly_target");
    expect(r.recommended).toBeNull();
    // And it is NOT uncertainty: the numbers are clear, they are just bad, so
    // there is nothing to ask the seller for.
    expect(r.uncertain).toBe(false);
    expect(r.askFor).toBeNull();
  });
});

describe("repair uplift is guidance, not money (AC2, AC6)", () => {
  it("a repairable defect holds back the as-is recommendation", () => {
    const r = advise({
      value: value({ remainingContributionCents: 200, lowCents: 150, highCents: 250 }),
      defects: [REPAIRABLE],
    });
    expect(pick(r, "sell_as_is")!.reasons).toContain("repairable_defect_may_lift_value");
  });

  it("and it is a REASON, never added to any contribution", () => {
    const withDefect = advise({ defects: [REPAIRABLE] });
    const without = advise({ defects: [] });
    // The numbers are identical. A speculative repair gain must not become
    // money in a comparison the seller acts on.
    expect(pick(withDefect, "sell_as_is")!.futureContributionCents)
      .toBe(pick(without, "sell_as_is")!.futureContributionCents);
    expect(pick(withDefect, "continue_prep")!.futureContributionCents)
      .toBe(pick(without, "continue_prep")!.futureContributionCents);
  });

  it("a permanent defect makes no repair promise at all", () => {
    const r = advise({
      value: value({ remainingContributionCents: 200, lowCents: 150, highCents: 250 }),
      defects: [PERMANENT],
    });
    expect(pick(r, "sell_as_is")!.reasons)
      .not.toContain("repairable_defect_may_lift_value");
    // And a low-value item with nothing repairable CAN reach donation review.
    expect(pick(r, "donation_review")).toBeTruthy();
  });

  it("a repairable defect keeps donation off the table", () => {
    // Suggesting a seller give away something a $6 repair would fix is the
    // worst version of this feature.
    const r = advise({
      value: value({ remainingContributionCents: 200, lowCents: 150, highCents: 250 }),
      defects: [REPAIRABLE],
    });
    expect(pick(r, "donation_review")).toBeUndefined();
  });

  it("the summed per-defect total is never read", () => {
    const src = codeOf("src/lib/work-advice.ts");
    expect(src).not.toContain("totalValueLiftPct");
    expect(src).not.toContain("totalGradeLift");
    expect(src).toContain("export function adviseOnItem");
  });
});

describe("bundles are a review, never a price (AC4, AC6)", () => {
  it("offered only when the seller owns items it could go with", () => {
    const none = advise({ eligibleBundleItemCount: 0 });
    expect(pick(none, "bundle_review")!.reasons).toContain("no_eligible_bundle_items");
    expect(pick(none, "bundle_review")!.actionHref).toBeNull();

    const some = advise({ eligibleBundleItemCount: 3, bundleHref: "/dashboard/flipdesk/inventory" });
    expect(pick(some, "bundle_review")!.reasons).toContain("bundle_price_unsupported");
    expect(pick(some, "bundle_review")!.actionHref).toBe("/dashboard/flipdesk/inventory");
  });

  it("carries NO contribution figure, ever", () => {
    // Nobody has a bundle buyer and nobody has a bundle price. Inventing
    // either would be the clearest possible fabrication on this screen.
    for (const count of [0, 1, 9]) {
      expect(pick(advise({ eligibleBundleItemCount: count }), "bundle_review")!
        .futureContributionCents).toBeNull();
    }
  });

  it("is never the recommendation, because it has nothing to compare", () => {
    const r = advise({ eligibleBundleItemCount: 5 });
    expect(r.recommended).not.toBe("bundle_review");
  });
});

describe("donation is a review with no value claim (AC4, AC6)", () => {
  it("only appears when what is left really is poor", () => {
    const good = advise();
    expect(pick(good, "donation_review")).toBeUndefined();
    const poor = advise({
      value: value({
        remainingContributionCents: LOW_VALUE_FLOOR_CENTS - 1,
        lowCents: 100,
        highCents: 200,
      }),
    });
    expect(pick(poor, "donation_review")).toBeTruthy();
  });

  it("makes no tax or value claim of any kind", () => {
    const src = codeOf("src/lib/work-advice.ts");
    for (const banned of ["deduction", "taxDeduct", "writeOff", "write_off", "fairMarket"]) {
      expect(src, `work-advice.ts mentions "${banned}"`).not.toContain(banned);
    }
    const r = advise({
      value: value({ remainingContributionCents: 100, lowCents: 50, highCents: 150 }),
    });
    expect(pick(r, "donation_review")!.futureContributionCents).toBeNull();
  });

  it("is never the recommendation", () => {
    const r = advise({
      value: value({ remainingContributionCents: 100, lowCents: 50, highCents: 150 }),
    });
    expect(r.recommended).not.toBe("donation_review");
  });
});

describe("missing evidence asks rather than guesses (AC3, AC6)", () => {
  it("no price evidence asks for a price, and recommends nothing", () => {
    const incomplete: ValueResult = {
      complete: false,
      reason: "no_price_evidence",
      missing: ["price_evidence"],
      researchable: true,
      horizonDays: 30,
    };
    const r = advise({ value: incomplete });
    expect(r.recommended).toBeNull();
    expect(r.uncertain).toBe(true);
    expect(r.askFor).toBe("needs_price_evidence");
  });

  it("an unsupported fee schedule is uncertainty, not a recommendation", () => {
    const incomplete: ValueResult = {
      complete: false,
      reason: "unsupported_fee_schedule",
      missing: [],
      researchable: false,
      horizonDays: 30,
    };
    const r = advise({ value: incomplete });
    expect(r.askFor).toBe("evidence_too_weak_to_choose");
    expect(r.recommended).toBeNull();
  });

  it("near break-even is UNCERTAIN rather than a coin flip", () => {
    // The band is the estimate's own low-to-high spread, and a wide one means
    // weak evidence. A contribution inside half that band of zero is noise,
    // and recommending on it would present noise as a finding.
    const r = advise({
      value: value({ remainingContributionCents: 800, lowCents: 0, highCents: 8000 }),
      remainingCostCents: 300,
      hourlyTargetCents: null,
    });
    expect(r.uncertain).toBe(true);
    expect(r.recommended).toBeNull();
    expect(r.askFor).not.toBeNull();
  });

  it("a confident positive number IS a recommendation", () => {
    // The other side of the same rule: a tight band and a clear margin means
    // the model should say so rather than hedge.
    const r = advise({
      value: value({ remainingContributionCents: 4200, lowCents: 4000, highCents: 4400 }),
      remainingCostCents: 300,
      hourlyTargetCents: null,
    });
    expect(r.recommended).toBe("continue_prep");
    expect(r.uncertain).toBe(false);
  });

  it("a wide-open estimate asks for the ONE input that would settle it", () => {
    const noTarget = advise({
      value: value({ lowCents: 0, highCents: 10000 }),
      remainingCostCents: 10,
      hourlyTargetCents: null,
    });
    expect(noTarget.askFor).toBe("needs_time_estimate");

    const withTarget = advise({
      value: value({ lowCents: 0, highCents: 10000, missing: ["purchase_price"] }),
      remainingCostCents: 10,
      hourlyTargetCents: 2000,
      remainingMinutes: 1,
    });
    expect(withTarget.askFor).toBe("needs_purchase_cost");
  });

  it("an old listing alone never reaches donation", () => {
    // AC3 names this explicitly. Age is not evidence about value, and this
    // module is given no age at all -- which is the strongest form of the
    // guarantee.
    const src = codeOf("src/lib/work-advice.ts");
    for (const banned of ["daysListed", "listedAt", "ageDays", "staleDays"]) {
      expect(src, `work-advice.ts reads "${banned}"`).not.toContain(banned);
    }
  });
});

describe("sold stock is not reconsidered (AC4, AC6)", () => {
  it("a sold or committed item gets one reason and no options", () => {
    const r = advise({ soldOrCommitted: true });
    expect(r.recommended).toBeNull();
    expect(r.alternatives).toHaveLength(1);
    expect(r.alternatives[0]!.reasons).toEqual(["item_already_sold_or_committed"]);
    // Offering to donate something a buyer has paid for is the worst possible
    // suggestion this screen could make.
    expect(pick(r, "donation_review")).toBeUndefined();
    expect(pick(r, "bundle_review")).toBeUndefined();
  });
});

describe("it changes nothing (AC4, AC5)", () => {
  it("no write, no delete, no listing action", () => {
    const src = codeOf("src/lib/work-advice.ts");
    for (const banned of ["delete", "supabase", "fetch(", "update(", "insert(", "delist"]) {
      expect(src, `work-advice.ts contains "${banned}"`).not.toContain(banned);
    }
  });

  it("is deterministic and reads no clock", () => {
    const src = codeOf("src/lib/work-advice.ts");
    expect(src).not.toContain("Date.now()");
    expect(src).not.toContain("Math.random");
    expect(JSON.stringify(advise())).toBe(JSON.stringify(advise()));
  });

  it("every option and reason code it can emit is declared", () => {
    const seen = new Set<string>();
    const inputs: Partial<AdviceInput>[] = [
      {},
      { soldOrCommitted: true },
      { eligibleBundleItemCount: 2 },
      { defects: [REPAIRABLE] },
      { hourlyTargetCents: 9000, remainingMinutes: 200 },
      { value: value({ remainingContributionCents: 100, lowCents: 50, highCents: 150 }) },
    ];
    for (const i of inputs) {
      const r = advise(i);
      for (const a of r.alternatives) {
        seen.add(a.option);
        for (const c of a.reasons) seen.add(c);
      }
      if (r.askFor) seen.add(r.askFor);
    }
    for (const s of seen) {
      const known = (ADVICE_OPTIONS as readonly string[]).includes(s) ||
        (REASON_CODES as readonly string[]).includes(s);
      expect(known, `"${s}" is emitted but not declared`).toBe(true);
    }
    // Guards the guard: an empty set would pass the loop above.
    expect(seen.size).toBeGreaterThan(5);
  });
});

function codeOf(rel: string): string {
  // Comments stripped as BLOCKS: the header explains what this file must not
  // do, so a naive scan finds the banned word inside the sentence forbidding
  // it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}
