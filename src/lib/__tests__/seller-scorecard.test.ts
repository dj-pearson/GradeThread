// US-2822. pickBiggestGap decides the one sentence a seller reads, so the three
// ways it can be wrong are all pinned here: inventing a finding when nothing is
// ranked, picking a different metric on a tie depending on payload order, and
// getting a lower_is_better metric backwards.
//
// The direction case is the subtle one. The RPC already flips the percentile so
// 100 is best in both directions; if this module ALSO flipped it, a seller with
// the worst return rate on the platform would be told their sell-through was
// the problem.

import { describe, expect, it } from "vitest";
import {
  DIAGNOSIS,
  diagnosisLine,
  EMPTY_SCORECARD,
  formatMetricValue,
  isUnranked,
  METRIC_ORDER,
  orderedMetrics,
  pickBiggestGap,
  RETURN_SPLIT_MIN_SALES,
  returnSplitLine,
  type Scorecard,
  type ScorecardMetric,
  type ScorecardRow,
} from "@/lib/seller-scorecard";

const DIRECTION: Record<ScorecardMetric, "higher_is_better" | "lower_is_better"> =
  {
    sell_through: "higher_is_better",
    price_realization: "higher_is_better",
    days_to_sell: "lower_is_better",
    return_rate: "lower_is_better",
    grade_yield: "higher_is_better",
  };

function row(
  metric: ScorecardMetric,
  percentile: number | null,
  over: Partial<ScorecardRow> = {},
): ScorecardRow {
  return {
    metric,
    direction: DIRECTION[metric],
    ownValue: 0.5,
    ownSampleSize: 20,
    cohortSellers: 14,
    cohortP25: 0.3,
    cohortMedian: 0.5,
    cohortP75: 0.7,
    ownPercentile: percentile,
    ...over,
  };
}

function card(metrics: ScorecardRow[]): Scorecard {
  return { ...EMPTY_SCORECARD, metrics };
}

describe("pickBiggestGap", () => {
  it("returns the lowest percentile", () => {
    const c = card([
      row("sell_through", 71),
      row("price_realization", 22),
      row("days_to_sell", 55),
    ]);
    expect(pickBiggestGap(c)?.metric).toBe("price_realization");
  });

  it("returns null when NOTHING is ranked", () => {
    // Every cohort under the floor. There is no biggest gap, and naming one
    // would be inventing the finding rather than reporting it.
    const c = card([
      row("sell_through", null, { cohortSellers: 2 }),
      row("return_rate", null, { cohortSellers: 1 }),
    ]);
    expect(pickBiggestGap(c)).toBeNull();
    expect(diagnosisLine(c)).toBeNull();
    expect(isUnranked(c)).toBe(true);
  });

  it("returns null on an empty scorecard", () => {
    expect(pickBiggestGap(EMPTY_SCORECARD)).toBeNull();
  });

  it("ignores unranked metrics even when other metrics ARE ranked", () => {
    const c = card([
      row("sell_through", 80),
      // No rank. Not a zero, and must not win by being treated as one.
      row("grade_yield", null, { cohortSellers: 3 }),
    ]);
    expect(pickBiggestGap(c)?.metric).toBe("sell_through");
  });

  it("breaks an exact tie on METRIC_ORDER, not on payload order", () => {
    const forward = card([row("sell_through", 30), row("return_rate", 30)]);
    const reversed = card([row("return_rate", 30), row("sell_through", 30)]);
    expect(pickBiggestGap(forward)?.metric).toBe("sell_through");
    expect(pickBiggestGap(reversed)?.metric).toBe("sell_through");
  });

  it("lets a lower_is_better metric win, because the RPC already flipped it", () => {
    // A 4% return rate is BAD and arrives as percentile 8. A module that
    // re-flipped the direction would read that as 92 and blame sell-through.
    const c = card([
      row("sell_through", 64, { ownValue: 0.64 }),
      row("return_rate", 8, { ownValue: 0.04 }),
      row("days_to_sell", 40, { ownValue: 31 }),
    ]);
    const worst = pickBiggestGap(c);
    expect(worst?.metric).toBe("return_rate");
    expect(worst?.direction).toBe("lower_is_better");
    expect(diagnosisLine(c)).toBe(DIAGNOSIS.return_rate);
  });

  it("treats a genuine zero percentile as a rank, not as missing", () => {
    const c = card([row("sell_through", 50), row("days_to_sell", 0)]);
    expect(pickBiggestGap(c)?.metric).toBe("days_to_sell");
  });
});

describe("diagnosisLine", () => {
  it("names an action for every metric and never restates the number", () => {
    for (const m of METRIC_ORDER) {
      const line = DIAGNOSIS[m];
      expect(line.length).toBeGreaterThan(20);
      // A template that quoted the value would drift from the value on screen.
      expect(line).not.toMatch(/\d+%|\bpercentile\b/);
    }
  });

  it("is the template for whichever metric won", () => {
    const c = card([row("sell_through", 12), row("return_rate", 90)]);
    expect(diagnosisLine(c)).toBe(DIAGNOSIS.sell_through);
  });
});

describe("orderedMetrics", () => {
  it("sorts to display order whatever the payload order was", () => {
    const c = card([
      row("grade_yield", 10),
      row("sell_through", 20),
      row("return_rate", 30),
    ]);
    expect(orderedMetrics(c).map((m) => m.metric)).toEqual([
      "sell_through",
      "return_rate",
      "grade_yield",
    ]);
  });
});

describe("formatMetricValue", () => {
  it("renders each metric in its own unit", () => {
    expect(formatMetricValue("sell_through", 0.64)).toBe("64%");
    expect(formatMetricValue("return_rate", 0.04)).toBe("4%");
    expect(formatMetricValue("days_to_sell", 31.4)).toBe("31d");
    expect(formatMetricValue("grade_yield", 7.83)).toBe("7.8");
  });

  it("renders a missing value as a dash, never as zero", () => {
    expect(formatMetricValue("sell_through", null)).toBe("—");
    expect(formatMetricValue("days_to_sell", Number.NaN)).toBe("—");
  });
});

// US-9208 AC2: both rates and the sample size; under 20 sales a side, words.
describe("returnSplitLine", () => {
  it("the floor is twenty sales a side", () => {
    expect(RETURN_SPLIT_MIN_SALES).toBe(20);
  });
  it("says not enough sales yet under the floor, never a percentage", () => {
    const thin = returnSplitLine({ fulfilled: 19, returns: 0 }, "Graded at sale");
    expect(thin.kind).toBe("thin");
    expect(thin.text).toBe("Graded at sale: not enough sales yet (19 of 20)");
    expect(thin.text).not.toMatch(/%/);
    expect(returnSplitLine({ fulfilled: 0, returns: 0 }, "Ungraded").kind).toBe("thin");
  });
  it("at the floor it shows the rate and the sample", () => {
    const line = returnSplitLine({ fulfilled: 20, returns: 1 }, "Graded at sale");
    expect(line.kind).toBe("rate");
    expect(line.text).toBe("Graded at sale: 5.0% of 20 sales");
    expect(returnSplitLine({ fulfilled: 64, returns: 2 }, "Ungraded").text).toBe("Ungraded: 3.1% of 64 sales");
  });
  it("the empty scorecard carries a zero split so an older RPC renders as thin", () => {
    expect(EMPTY_SCORECARD.returnSplit.graded).toEqual({ fulfilled: 0, returns: 0 });
  });
});
