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

export interface Scorecard {
  periodStart: string | null;
  minSellers: number;
  minActivity: number;
  metrics: ScorecardRow[];
}

export const EMPTY_SCORECARD: Scorecard = {
  periodStart: null,
  minSellers: 5,
  minActivity: 5,
  metrics: [],
};

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
 * The single weakest metric.
 *
 * Only metrics with a real percentile can win: a metric whose cohort was too
 * small has no rank, and calling an unranked metric the biggest gap would be
 * inventing the finding. Ties break on METRIC_ORDER so the sentence is stable
 * across renders rather than depending on payload order.
 */
export function pickBiggestGap(card: Scorecard): ScorecardRow | null {
  const ranked = card.metrics.filter(
    (m) => m.ownPercentile != null && Number.isFinite(m.ownPercentile),
  );
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
  return card.metrics.every((m) => m.ownPercentile == null);
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
