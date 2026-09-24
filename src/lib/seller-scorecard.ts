// US-2822: the Seller Scorecard.
//
// seller_scorecard (migration 00654) returns five metrics, each with the
// caller's own value, the cohort quartiles, and a percentile where the cohort
// was large enough to have one. This module turns that into the one sentence
// the card leads with.
//
// THE DIAGNOSIS IS A TEMPLATE TABLE, NOT A MODEL CALL. Five metrics have five
// fixed things to say, the sentence has to be identical every render, and a
// per-view AI call to produce a line that never changes is a cost with no
// upside. It also makes the copy testable, which is the point of DIAGNOSIS
// below.

import { supabase } from "@/lib/supabase";
import { normaliseAgainst } from "@/lib/rpc-shape";
import { ordinal } from "@/lib/utils";
import { tabPath } from "@/lib/analytics-tabs";
import { encodeQuery, type FilterQuery } from "@/lib/item-filter";

export type ScorecardMetric =
  | "sell_through"
  | "price_realization"
  | "days_to_sell"
  | "return_rate"
  | "grade_yield";

export type MetricDirection = "higher_is_better" | "lower_is_better";

export interface ScorecardRow {
  metric: ScorecardMetric;
  direction: MetricDirection;
  ownValue: number | null;
  ownSampleSize: number;
  cohortSellers: number;
  cohortP25: number | null;
  cohortMedian: number | null;
  cohortP75: number | null;
  /** 0..100, where 100 is best regardless of direction. Null under the floor. */
  ownPercentile: number | null;
}

/** US-9208: fulfilled and refunded counts on one side of the graded split. */
export interface ReturnSplitSide {
  fulfilled: number;
  returns: number;
}

export interface ReturnSplit {
  /** The sold listing carried a grade when it sold. */
  graded: ReturnSplitSide;
  ungraded: ReturnSplitSide;
}

export interface Scorecard {
  periodStart: string | null;
  minSellers: number;
  minActivity: number;
  metrics: ScorecardRow[];
  /** US-9208 (migration 00717). Zero counts when the RPC predates the key. */
  returnSplit: ReturnSplit;
}

export const EMPTY_RETURN_SPLIT: ReturnSplit = {
  graded: { fulfilled: 0, returns: 0 },
  ungraded: { fulfilled: 0, returns: 0 },
};

export const EMPTY_SCORECARD: Scorecard = {
  periodStart: null,
  minSellers: 5,
  minActivity: 5,
  metrics: [],
  returnSplit: EMPTY_RETURN_SPLIT,
};

/**
 * US-9208 AC2: sales a side needs before a return percentage is shown. Below
 * it the card says "not enough sales yet", and the aggregate that feeds the
 * data report holds the same floor (src/lib/resale-report.ts).
 */
export const RETURN_SPLIT_MIN_SALES = 20;

export type ReturnSplitLine =
  | { kind: "rate"; rate: number; fulfilled: number; text: string }
  | { kind: "thin"; fulfilled: number; text: string };

/** One side of the split as the card prints it. Never a percentage under the floor. */
export function returnSplitLine(side: ReturnSplitSide, label: string): ReturnSplitLine {
  const fulfilled = Math.max(0, Math.floor(side.fulfilled));
  if (fulfilled < RETURN_SPLIT_MIN_SALES) {
    return {
      kind: "thin",
      fulfilled,
      text: `${label}: not enough sales yet (${fulfilled} of ${RETURN_SPLIT_MIN_SALES})`,
    };
  }
  const rate = Math.max(0, side.returns) / fulfilled;
  return {
    kind: "rate",
    rate,
    fulfilled,
    text: `${label}: ${(rate * 100).toFixed(1)}% of ${fulfilled} sales`,
  };
}

/**
 * The Analytics tab that explains each metric. The tile links there, keeping
 * the query string (A5), so a seller on ?preset=30d lands on the same range.
 */
export const SCORECARD_TAB_FOR: Record<ScorecardMetric, string> = {
  sell_through: tabPath("sell-through"),
  price_realization: tabPath("price-curve"),
  days_to_sell: tabPath("sell-through"),
  return_rate: tabPath("returns"),
  grade_yield: tabPath("grading-roi"),
};

export function scorecardTileHref(
  metric: ScorecardMetric,
  search: string,
): { pathname: string; search: string } {
  return { pathname: SCORECARD_TAB_FOR[metric], search };
}

/** Display order, and the tie-break order for pickBiggestGap. */
export const METRIC_ORDER: readonly ScorecardMetric[] = [
  "sell_through",
  "price_realization",
  "days_to_sell",
  "return_rate",
  "grade_yield",
];

export const METRIC_LABEL: Record<ScorecardMetric, string> = {
  sell_through: "Sell-through",
  price_realization: "Price realization",
  days_to_sell: "Days to sell",
  return_rate: "Return rate",
  grade_yield: "Grade yield",
};

/** How to render each metric's raw value. */
export const METRIC_FORMAT: Record<ScorecardMetric, "percent" | "days" | "grade"> =
  {
    sell_through: "percent",
    price_realization: "percent",
    days_to_sell: "days",
    return_rate: "percent",
    grade_yield: "grade",
  };

export function formatMetricValue(
  metric: ScorecardMetric,
  value: number | null,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (METRIC_FORMAT[metric]) {
    case "percent":
      return `${Math.round(value * 100)}%`;
    case "days":
      return `${Math.round(value)}d`;
    case "grade":
      return value.toFixed(1);
  }
}

/**
 * What to say when a metric is the weakest one. Fixed strings, keyed on the
 * metric, deliberately naming an action rather than restating the number.
 */
export const DIAGNOSIS: Record<ScorecardMetric, string> = {
  sell_through:
    "Your listings are not converting. That is usually a pricing or a photo problem, not a sourcing one.",
  price_realization:
    "You are discounting to close. Look at what you list at versus what you accept.",
  days_to_sell:
    "Your inventory sits. Capital tied up in slow stock is the most expensive thing in reselling.",
  return_rate:
    "Buyers are sending items back. Check what your listings disclose against what the grade found.",
  grade_yield:
    "What you are buying is in worse shape than what other sellers buy. This one is fixed at the source, not the listing.",
};

/**
 * A5: a metric is ranked only when the cohort gave it a percentile AND the
 * caller's own sample clears minActivity. The RPC holds OTHER sellers to that
 * floor but ranked the caller on whatever they had, so one sale of one listing
 * could read as the weakest sell-through on the platform.
 */
export function rankedPercentile(
  card: Scorecard,
  m: ScorecardRow,
): number | null {
  if (m.ownPercentile == null || !Number.isFinite(m.ownPercentile)) return null;
  if (m.ownSampleSize < card.minActivity) return null;
  return m.ownPercentile;
}

/**
 * The line under a tile's value. Each unranked case says which floor it is
 * waiting on, so "40 of 5 peers" (a big cohort, a small own sample) can no
 * longer be printed.
 */
export function tileRankText(card: Scorecard, m: ScorecardRow): string {
  if (m.ownValue == null || !Number.isFinite(m.ownValue)) return "No data yet";
  if (m.ownSampleSize < card.minActivity) {
    return `${m.ownSampleSize} of ${card.minActivity} items needed`;
  }
  const p = rankedPercentile(card, m);
  if (p != null) return `${ordinal(p)} percentile`;
  return `Ranks at ${card.minSellers} sellers (${m.cohortSellers} so far)`;
}

/**
 * The single weakest metric.
 *
 * Only metrics with a real percentile can win: a metric whose cohort was too
 * small has no rank, and calling an unranked metric the biggest gap would be
 * inventing the finding. Ties break on METRIC_ORDER so the sentence is stable
 * across renders rather than depending on payload order.
 */
export function pickBiggestGap(card: Scorecard): ScorecardRow | null {
  const ranked = card.metrics.filter((m) => rankedPercentile(card, m) != null);
  if (ranked.length === 0) return null;
  return ranked.reduce((worst, m) => {
    if (m.ownPercentile! < worst.ownPercentile!) return m;
    if (m.ownPercentile! > worst.ownPercentile!) return worst;
    return METRIC_ORDER.indexOf(m.metric) < METRIC_ORDER.indexOf(worst.metric)
      ? m
      : worst;
  });
}

/** The lead sentence, or null when nothing is ranked. */
export function diagnosisLine(card: Scorecard): string | null {
  const worst = pickBiggestGap(card);
  if (!worst) return null;
  return DIAGNOSIS[worst.metric];
}

/** Rows in display order, whatever order the payload arrived in. */
export function orderedMetrics(card: Scorecard): ScorecardRow[] {
  return [...card.metrics].sort(
    (a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric),
  );
}

/** True when no metric could be ranked, so the card should say why. */
export function isUnranked(card: Scorecard): boolean {
  return card.metrics.every((m) => rankedPercentile(card, m) == null);
}

// ─── Fetch ───────────────────────────────────────────────────────

type RpcClient = {
  rpc: (
    fn: "seller_scorecard",
    args: { p_period_start: string | null },
  ) => Promise<{
    data: Scorecard | null;
    error: { message: string } | null;
  }>;
};

export async function fetchSellerScorecard(
  periodStart: string | null,
): Promise<Scorecard> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("seller_scorecard", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  // US-2838: the cast above makes `data: X | null` an assertion, not a check,
  // and `?? EMPTY_SCORECARD` only catches null. An empty ARRAY — what the e2e mock
  // sends for any unmatched RPC — passed straight through and took a whole
  // route down through the ErrorBoundary. normaliseAgainst forces the shape.
  return normaliseAgainst(EMPTY_SCORECARD, data);
}

// ─── A14: from diagnosis to a work queue ─────────────────────────────────────

/** Where the inventory page opens for a filtered queue. */
const INVENTORY = "/dashboard/flipdesk/inventory";
/** Unsold stock, for the queues below. */
const UNSOLD = "sold,shipped,completed,archived";

function inventoryQueue(rules: FilterQuery["rules"]): string {
  return `${INVENTORY}?filter=${encodeURIComponent(encodeQuery({ combinator: "and", rules }))}`;
}

export const FIX_LABEL: Record<ScorecardMetric, string> = {
  sell_through: "See listings that aren't selling",
  price_realization: "Review your pricing",
  days_to_sell: "See your slowest stock",
  return_rate: "See what predicts your returns",
  grade_yield: "Compare your sources",
};

/**
 * A14: the one place a weak metric can be worked on, as a real route with the
 * filter already applied. `search` is the Analytics query string; it rides
 * along only to links that stay inside Analytics, where it carries the range.
 */
export function fixThisHref(
  metric: ScorecardMetric,
  row: Pick<ScorecardRow, "cohortMedian"> | null,
  search: string,
): string {
  switch (metric) {
    case "price_realization":
      return "/dashboard/flipdesk/pricing";
    case "sell_through":
      // Live listings that have sat 30+ days: the ones dragging the rate.
      return inventoryQueue([
        { id: "fix-status", field: "status", op: "eq", value: "listed" },
        { id: "fix-age", field: "days_listed", op: "gte", value: "30" },
      ]);
    case "days_to_sell": {
      // Older than the peer median, where one exists, else 30 days.
      const median = row?.cohortMedian;
      const days =
        median != null && Number.isFinite(median) && median > 0
          ? Math.round(median)
          : 30;
      return inventoryQueue([
        { id: "fix-status", field: "status", op: "eq", value: "listed" },
        { id: "fix-age", field: "days_listed", op: "gte", value: String(days) },
      ]);
    }
    case "return_rate":
      return `${tabPath("returns")}${search}#return-attribution`;
    case "grade_yield":
      return "/dashboard/flipdesk/sourcing?tab=sources";
  }
}

/** A14: unsold, ungraded stock: the queue behind "grade these items". */
export function ungradedStockHref(): string {
  return inventoryQueue([
    { id: "grade-none", field: "grade", op: "isnull", value: "" },
    { id: "grade-unsold", field: "status", op: "nin", value: UNSOLD },
  ]);
}

/**
 * A14: "38% vs 45% peer median" for a ranked tile, or null. Only where the
 * RPC returned a cohort median, and only where the tile is ranked: a median
 * beside an unranked tile would be the comparison the floor withheld.
 */
export function medianCompareText(card: Scorecard, m: ScorecardRow): string | null {
  if (rankedPercentile(card, m) == null) return null;
  if (m.cohortMedian == null || !Number.isFinite(m.cohortMedian)) return null;
  return `${formatMetricValue(m.metric, m.ownValue)} vs ${formatMetricValue(
    m.metric,
    m.cohortMedian,
  )} peer median`;
}

/**
 * A14: how many points fewer graded sales came back than ungraded ones, when
 * both sides clear RETURN_SPLIT_MIN_SALES and graded is actually better.
 * Null otherwise; a worse or thin number is never turned into a pitch.
 */
export function gradedReturnGapPoints(split: ReturnSplit): number | null {
  const g = returnSplitLine(split.graded, "g");
  const u = returnSplitLine(split.ungraded, "u");
  if (g.kind !== "rate" || u.kind !== "rate") return null;
  const pts = Math.round((u.rate - g.rate) * 100);
  return pts >= 1 ? pts : null;
}
