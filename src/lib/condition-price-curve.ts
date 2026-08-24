// US-2819: the Condition Price Curve — median realized price and days-to-sell
// at each half grade point, for a brand or a category.
//
// The RPC (migration 00651) does the aggregation and the k-anonymity
// suppression. Everything here is pure over its payload apart from
// fetchConditionPriceCurve, so the reading rules are testable without a
// database.
//
// THE ONE RULE WORTH STATING ONCE: a bucket has two independent sides. The
// caller's own sales are theirs at any sample size. The cohort side is null
// unless enough distinct sellers stand behind it, and `cohortSuppressed` says
// which of "no market" and "not enough sellers" is true. Reading a null cohort
// median as zero would turn a privacy rule into a price.

import { supabase } from "@/lib/supabase";
import { normaliseAgainst } from "@/lib/rpc-shape";

/** Half-point buckets from 1.0 to 10.0 inclusive. 19 of them. */
export const CURVE_GRADES: readonly number[] = Array.from(
  { length: 19 },
  (_, i) => (i + 2) / 2,
);

/**
 * Observations a bucket needs before a median is quoted as a price. Below it a
 * bucket still renders (with its count) and never carries a recommendation.
 * US-2820 scores sold items against this same floor.
 */
export const MIN_CURVE_SAMPLE = 5;

export interface CurveBucket {
  grade: number;
  ownCount: number;
  ownMedianPrice: number | null;
  ownMedianDays: number | null;
  cohortCount: number;
  cohortSellers: number;
  /** True when cohortSellers is under the k-anonymity floor. */
  cohortSuppressed: boolean;
  cohortMedianPrice: number | null;
  cohortP25Price: number | null;
  cohortP75Price: number | null;
  cohortMedianDays: number | null;
}

export interface ConditionPriceCurve {
  brand: string | null;
  category: string | null;
  periodStart: string | null;
  minSellers: number;
  ownTotal: number;
  cohortTotal: number;
  cohortSellersTotal: number;
  buckets: CurveBucket[];
}

/** Which side of a bucket a quoted figure came from. */
export type CurveSource = "cohort" | "own";

export interface EffectivePrice {
  price: number | null;
  source: CurveSource | null;
  /** Observations behind `price`, so a caller can apply MIN_CURVE_SAMPLE. */
  count: number;
}

// ─── Pure readers ────────────────────────────────────────────────

/** Round a raw 0.1-step grade to the half point the curve buckets it under. */
export function bucketGrade(grade: number): number {
  return Math.round(grade * 2) / 2;
}

/** The bucket a grade falls in, or null when the grade is off the scale. */
export function bucketFor(
  curve: ConditionPriceCurve,
  grade: number,
): CurveBucket | null {
  if (!Number.isFinite(grade)) return null;
  const g = bucketGrade(grade);
  if (g < 1 || g > 10) return null;
  return curve.buckets.find((b) => bucketGrade(b.grade) === g) ?? null;
}

/**
 * The price to quote for a bucket.
 *
 * Cohort first when it survived suppression — it is the broader market and it
 * is the number a pricing decision wants. Own data is the fallback, which is
 * what a seller in a thin category is left with, and it is labeled as such so
 * the UI never presents one seller's three sales as a market rate.
 */
export function effectivePrice(bucket: CurveBucket | null): EffectivePrice {
  if (!bucket) return { price: null, source: null, count: 0 };
  if (!bucket.cohortSuppressed && bucket.cohortMedianPrice != null) {
    return {
      price: bucket.cohortMedianPrice,
      source: "cohort",
      count: bucket.cohortCount,
    };
  }
  if (bucket.ownMedianPrice != null) {
    return {
      price: bucket.ownMedianPrice,
      source: "own",
      count: bucket.ownCount,
    };
  }
  return { price: null, source: null, count: 0 };
}

/**
 * What the step from `fromGrade` up to `toGrade` is worth in dollars, using
 * whichever side of each bucket survived. Null unless BOTH ends clear
 * MIN_CURVE_SAMPLE — a spread between a 40-sale bucket and a 1-sale bucket is
 * a number about the 1-sale bucket.
 */
export function gradeStepValue(
  curve: ConditionPriceCurve,
  fromGrade: number,
  toGrade: number,
): number | null {
  const lo = effectivePrice(bucketFor(curve, fromGrade));
  const hi = effectivePrice(bucketFor(curve, toGrade));
  if (lo.price == null || hi.price == null) return null;
  if (lo.count < MIN_CURVE_SAMPLE || hi.count < MIN_CURVE_SAMPLE) return null;
  return hi.price - lo.price;
}

/** Buckets that carry a quotable price, low grade first. */
export function quotableBuckets(curve: ConditionPriceCurve): CurveBucket[] {
  return curve.buckets
    .filter((b) => {
      const e = effectivePrice(b);
      return e.price != null && e.count >= MIN_CURVE_SAMPLE;
    })
    .sort((a, b) => a.grade - b.grade);
}

export interface CurveHeadline {
  lowGrade: number;
  highGrade: number;
  lowPrice: number;
  highPrice: number;
  /** Dollars per half grade point across the span. */
  perHalfPoint: number;
  source: CurveSource;
}

/**
 * The one sentence the page leads with: the widest span of quotable buckets and
 * what a half point is worth across it. Null when fewer than two buckets clear
 * the sample floor, which is the honest answer rather than a slope through one
 * point.
 */
export function curveHeadline(
  curve: ConditionPriceCurve,
): CurveHeadline | null {
  const q = quotableBuckets(curve);
  if (q.length < 2) return null;
  const low = q[0]!;
  const high = q[q.length - 1]!;
  const lowP = effectivePrice(low);
  const highP = effectivePrice(high);
  if (lowP.price == null || highP.price == null) return null;
  const steps = (high.grade - low.grade) * 2;
  if (steps <= 0) return null;
  return {
    lowGrade: low.grade,
    highGrade: high.grade,
    lowPrice: lowP.price,
    highPrice: highP.price,
    perHalfPoint: (highP.price - lowP.price) / steps,
    // The span is mixed-source only when one end fell back to own data; say
    // "own" in that case, because the weaker side is what limits the claim.
    source: lowP.source === "cohort" && highP.source === "cohort"
      ? "cohort"
      : "own",
  };
}

/** True when the curve has nothing to draw on either side. */
export function isCurveEmpty(curve: ConditionPriceCurve): boolean {
  return curve.ownTotal === 0 && curve.cohortTotal === 0;
}

/** Buckets held back purely by the seller floor, not by absent data. */
export function suppressedBuckets(curve: ConditionPriceCurve): CurveBucket[] {
  return curve.buckets.filter((b) => b.cohortSuppressed && b.cohortCount > 0);
}

export const EMPTY_CURVE: ConditionPriceCurve = {
  brand: null,
  category: null,
  periodStart: null,
  minSellers: 5,
  ownTotal: 0,
  cohortTotal: 0,
  cohortSellersTotal: 0,
  buckets: [],
};

// ─── Fetch ───────────────────────────────────────────────────────

// Not in the generated Database types; call through a narrowly typed view of
// the client (same pattern as flipdesk-analytics-server.ts).
type RpcClient = {
  rpc: (
    fn: "condition_price_curve",
    args: {
      p_brand: string | null;
      p_category: string | null;
      p_period_start: string | null;
    },
  ) => Promise<{
    data: ConditionPriceCurve | null;
    error: { message: string } | null;
  }>;
};

/**
 * The curve for one brand and/or category. Both filters null = every graded
 * item the caller can see plus the cohort behind it.
 */
export async function fetchConditionPriceCurve(args: {
  brand?: string | null;
  category?: string | null;
  periodStart?: string | null;
}): Promise<ConditionPriceCurve> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("condition_price_curve", {
    p_brand: args.brand ?? null,
    p_category: args.category ?? null,
    p_period_start: args.periodStart ?? null,
  });
  if (error) throw new Error(error.message);
  // US-2838: the cast above makes `data: X | null` an assertion, not a check,
  // and `?? EMPTY_CURVE` only catches null. An empty ARRAY — what the e2e mock
  // sends for any unmatched RPC — passed straight through and took a whole
  // route down through the ErrorBoundary. normaliseAgainst forces the shape.
  return normaliseAgainst(EMPTY_CURVE, data);
}
