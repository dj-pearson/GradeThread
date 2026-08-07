// US-1845: buyer-side product analytics that only the server can see.
//
// The SPA fires the funnel (src/lib/buyer-analytics.ts). The actions this file
// records are the ones with no browser in the loop, or no browser we trust to
// tell the truth: a metered spend, a guarantee decision, an extension check that
// arrived from the extension's own token. Those are the numbers "did the feature
// get used" has to be answered from, so they are captured where they happen.
//
// The feature keys are the SAME list the SPA uses and the same keys the admin
// adoption panel reports, so a PostHog series and a database count can be put
// side by side and mean one thing.
//
// PRIVACY. This is fire-and-forget PostHog capture keyed on the acting user's
// id, carrying only which feature ran and its outcome — no garment, no listing
// URL, no price, no marketplace identity. It rides the same
// legitimate-interest basis as the existing server-side billing lifecycle
// events (posthog.ts), and it captures nothing a signed-out visitor did: every
// call site sits behind authentication. It NEVER reuses a browser consent
// toggle to justify itself, per the telemetry-consent rule.

import { captureServer } from "./posthog.ts";

/** Kept in lockstep with BUYER_TRACKED_FEATURES in src/lib/buyer-analytics.ts. */
export const BUYER_TRACKED_FEATURES = [
  "extension_check",
  "alerts",
  "confirmations",
  "guarantee_claims",
  "portfolio",
  "wants",
  "authenticity",
  "video_grade",
] as const;

export type BuyerTrackedFeature = (typeof BUYER_TRACKED_FEATURES)[number];

export const BUYER_FEATURE_EVENT = "buyer_feature_used";

/**
 * Record one server-observed use of a buyer feature. Fire-and-forget by way of
 * captureServer, which swallows every error — analytics must never be able to
 * fail the action it is describing.
 */
export function trackBuyerFeature(
  userId: string | null | undefined,
  feature: BuyerTrackedFeature,
  action: string,
  props: Record<string, unknown> = {},
): void {
  if (!userId) return;
  void captureServer(userId, BUYER_FEATURE_EVENT, {
    feature,
    action,
    surface: "edge",
    ...props,
  });
}

// ── The flywheel metric ──────────────────────────────────────────────
//
// "Buyer demand → seller grading" is a claim about two time series moving
// together, so the honest form of it is a correlation coefficient over daily
// counts, reported WITH its sample size — not a single ratio that looks like a
// causal number and isn't.
//
// Pure, so the arithmetic is testable without a database.

export interface FlywheelPoint {
  date: string;
  buyer_demand: number;
  seller_grades: number;
}

export interface FlywheelSummary {
  /** Pearson r over the daily pairs, rounded to 2dp. null when undefined. */
  correlation: number | null;
  /** Days compared. r on a handful of points means nothing; the UI says so. */
  days: number;
  buyer_demand_total: number;
  seller_grades_total: number;
  /** Seller grades per unit of buyer demand over the window. null when no demand. */
  grades_per_demand: number | null;
}

/**
 * Pearson correlation of two equal-length series. Returns null when it is not
 * defined — fewer than two points, or a series with zero variance (a flat line
 * correlates with nothing, and returning 0 would read as "no relationship
 * measured" when the truth is "not measurable").
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** Summarize the daily flywheel series into the numbers the admin card shows. */
export function summarizeFlywheel(series: FlywheelPoint[]): FlywheelSummary {
  const demand = series.map((p) => p.buyer_demand);
  const grades = series.map((p) => p.seller_grades);
  const demandTotal = demand.reduce((a, b) => a + b, 0);
  const gradesTotal = grades.reduce((a, b) => a + b, 0);
  const r = pearson(demand, grades);
  return {
    correlation: r === null ? null : Math.round(r * 100) / 100,
    days: series.length,
    buyer_demand_total: demandTotal,
    seller_grades_total: gradesTotal,
    grades_per_demand:
      demandTotal === 0 ? null : Math.round((gradesTotal / demandTotal) * 100) / 100,
  };
}
