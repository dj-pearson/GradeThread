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

// ─── A5: ordinals, own-sample gate, honest unranked copy, range-keeping links ──

import { ordinal } from "@/lib/utils";
import {
  rankedPercentile,
  scorecardTileHref,
  tileRankText,
} from "@/lib/seller-scorecard";

describe("ordinal (A5)", () => {
  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [22, "22nd"],
    [101, "101st"],
  ])("%i -> %s", (n, s) => {
    expect(ordinal(n)).toBe(s);
  });
});

describe("own-sample gate (A5)", () => {
  it("a seller with 1 sold of 1 listed is not ranked, and is not the weakest", () => {
    const c = card([
      row("sell_through", 3, { ownValue: 1, ownSampleSize: 1 }),
      row("price_realization", 40),
    ]);
    expect(rankedPercentile(c, c.metrics[0]!)).toBeNull();
    expect(pickBiggestGap(c)?.metric).toBe("price_realization");
    expect(tileRankText(c, c.metrics[0]!)).toBe("1 of 5 items needed");
  });

  it("a card whose only percentile rests on a tiny own sample is unranked", () => {
    const c = card([row("sell_through", 3, { ownSampleSize: 2 })]);
    expect(isUnranked(c)).toBe(true);
    expect(diagnosisLine(c)).toBeNull();
  });
});

describe("tile rank text (A5)", () => {
  it("never reads '40 of 5 peers'", () => {
    const c = card([
      row("sell_through", null, { cohortSellers: 40, ownSampleSize: 2 }),
    ]);
    expect(tileRankText(c, c.metrics[0]!)).toBe("2 of 5 items needed");
  });
  it("says 'No data yet' with no own value", () => {
    const c = card([row("sell_through", null, { ownValue: null })]);
    expect(tileRankText(c, c.metrics[0]!)).toBe("No data yet");
  });
  it("names the cohort floor when the cohort is small", () => {
    const c = card([row("sell_through", null, { cohortSellers: 3 })]);
    expect(tileRankText(c, c.metrics[0]!)).toBe("Ranks at 5 sellers (3 so far)");
  });
  it("uses the right suffix", () => {
    const c = card([row("sell_through", 22)]);
    expect(tileRankText(c, c.metrics[0]!)).toBe("22nd percentile");
  });
});

describe("tile links keep the range (A5)", () => {
  it("carries ?preset=30d to the target tab", () => {
    expect(scorecardTileHref("return_rate", "?preset=30d")).toEqual({
      pathname: "/dashboard/flipdesk/analytics/returns",
      search: "?preset=30d",
    });
  });
});

// ─── A14: Fix this, you vs median, graded-return pitch ───────────────────────

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeQuery } from "@/lib/item-filter";
import {
  FIX_LABEL,
  fixThisHref,
  gradedReturnGapPoints,
  medianCompareText,
  ungradedStockHref,
} from "@/lib/seller-scorecard";

const ROUTES = readFileSync(resolve(process.cwd(), "src/routes/index.tsx"), "utf8");
const registered = (href: string) => {
  const path = href.split(/[?#]/)[0]!;
  return ROUTES.includes(`path: "${path}"`);
};
const filterOf = (href: string) => {
  const raw = new URL(href, "https://x.test").searchParams.get("filter");
  return raw ? decodeQuery(raw) : null;
};

describe("fixThisHref (A14)", () => {
  it.each(METRIC_ORDER.map((m) => [m]))("%s goes to a registered route", (metric) => {
    const href = fixThisHref(metric, "?preset=30d");
    expect(registered(href)).toBe(true);
    expect(FIX_LABEL[metric].length).toBeGreaterThan(0);
  });

  // The server-side filter (flipdesk_filter_matches) has no `days_listed`
  // field, so a rule on it matched nothing and the queue always opened empty.
  // The Aged tab is the server's own "live and old" predicate.
  it.each([["sell_through"], ["days_to_sell"]] as const)(
    "%s opens the Aged tab with no filter the server cannot evaluate",
    (metric) => {
      const href = fixThisHref(metric, "?preset=30d");
      const url = new URL(href, "https://x.test");
      expect(url.pathname).toBe("/dashboard/flipdesk/inventory");
      expect(url.searchParams.get("tab")).toBe("aged");
      expect(url.searchParams.get("filter")).toBeNull();
    },
  );

  it("no inventory queue uses a filter field the server-side matcher ignores", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/00728_filter_by_sourcer.sql"),
      "utf8",
    );
    const hrefs = [
      ...METRIC_ORDER.map((m) => fixThisHref(m, "")),
      ungradedStockHref(),
    ];
    for (const href of hrefs) {
      for (const r of filterOf(href)?.rules ?? []) {
        expect(sql).toContain(`when '${r.field}' then`);
      }
    }
  });

  it("return rate stays in Analytics, keeps the range and lands on the attribution card", () => {
    expect(fixThisHref("return_rate", "?preset=30d")).toBe(
      "/dashboard/flipdesk/analytics/returns?preset=30d#return-attribution",
    );
  });

  it("price realization and grade yield go to pricing and sources", () => {
    expect(fixThisHref("price_realization", "")).toBe("/dashboard/flipdesk/pricing");
    expect(fixThisHref("grade_yield", "")).toBe("/dashboard/flipdesk/sourcing?tab=sources");
  });

  it("the grade-ungraded queue is unsold stock with no grade", () => {
    const href = ungradedStockHref();
    expect(registered(href)).toBe(true);
    // Named tab: without it the table opens on the remembered tab, and a
    // remembered Sold tab would show none of this unsold stock.
    expect(new URL(href, "https://x.test").searchParams.get("tab")).toBe("all");
    const q = filterOf(href);
    expect(q?.rules.map((r) => [r.field, r.op])).toEqual([
      ["grade", "isnull"],
      ["status", "nin"],
    ]);
  });
});

describe("medianCompareText (A14)", () => {
  it("prints you vs the peer median on a ranked tile", () => {
    const c = card([row("sell_through", 30, { ownValue: 0.38, cohortMedian: 0.45 })]);
    expect(medianCompareText(c, c.metrics[0]!)).toBe("38% vs 45% peer median");
  });
  it("stays silent on an unranked tile or with no median", () => {
    const c = card([
      row("sell_through", null, { cohortMedian: 0.45 }),
      row("return_rate", 40, { cohortMedian: null }),
    ]);
    expect(medianCompareText(c, c.metrics[0]!)).toBeNull();
    expect(medianCompareText(c, c.metrics[1]!)).toBeNull();
  });
});

describe("gradedReturnGapPoints (A14)", () => {
  it("counts points when graded returns less on real samples", () => {
    expect(
      gradedReturnGapPoints({
        graded: { fulfilled: 40, returns: 2 },
        ungraded: { fulfilled: 50, returns: 6 },
      }),
    ).toBe(7);
  });
  it("is null when graded is worse or a side is thin", () => {
    expect(
      gradedReturnGapPoints({
        graded: { fulfilled: 40, returns: 8 },
        ungraded: { fulfilled: 50, returns: 6 },
      }),
    ).toBeNull();
    expect(
      gradedReturnGapPoints({
        graded: { fulfilled: 5, returns: 0 },
        ungraded: { fulfilled: 50, returns: 6 },
      }),
    ).toBeNull();
  });
});
