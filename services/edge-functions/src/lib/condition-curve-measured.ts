// US-2847: turn a fitted slope into the curve the public pages already render.
//
// condition_price_curves is the one curve table and it stays the one curve
// table. A measured cell writes the SAME point shape a seeded cell writes, so
// /condition-index and /value/{brand}/{item} need no new plumbing to show it -
// only the `provenance` column to say which kind it is looking at.
//
// TWO REFUSALS ARE LOAD-BEARING HERE.
//
// 1. NO EXTRAPOLATION. A line will happily quote a price at grade 10 for a cell
//    whose best read was a 7.5. That number is an opinion wearing a
//    measurement's clothes. Grades outside the observed range are marked
//    insufficient, and toDto already drops insufficient points, so they never
//    reach a page.
//
// 2. THE BAND IS THE MEASURED ERROR, not a decoration. low and high sit one
//    hold-out mean-absolute-error either side of the fitted median. That is the
//    curve's own out-of-sample miss on this cell, so the width of the band is a
//    fact about how well we know this garment rather than a fixed percentage
//    somebody picked.

import { type CurvePoint } from "./condition-curve.ts";
import { type CompReadSample, type CurveFit, type HoldOutScore, priceAtGrade } from "./comp-curve-fit.ts";

/** How near a read has to sit to count toward a grade point's sample size. */
export const GRADE_BUCKET_HALF_WIDTH = 0.5;

export interface MeasuredCurveInput {
  itemKey: string;
  slug: string | null;
  label: string | null;
  brand: string | null;
  categoryId: string;
  query: string | null;
  currency: string;
  fit: CurveFit;
  score: HoldOutScore;
  reads: CompReadSample[];
  /** ISO timestamp. Passed in rather than read from the clock so this stays pure. */
  measuredAt: string;
}

/** The row this module writes. Exported so the worker and the tests agree on it. */
export interface MeasuredCurveRow {
  item_key: string;
  slug: string | null;
  label: string | null;
  brand: string | null;
  category_id: string;
  query: string | null;
  currency: string;
  curve: CurvePoint[];
  total_sample_size: number;
  refreshed_at: string;
  provenance: "measured";
  slope_cents_per_point: number;
  fit_confidence: number;
  measured_at: string;
}

/**
 * How many fitted reads sit within half a grade point of this grade.
 *
 * The whole fit informs every point, so the honest per-grade number is not the
 * total sample - it is how much evidence sits near THIS grade. A page showing
 * "15 comps" against a grade nothing was read at would be true about the cell
 * and false about the point.
 */
export function readsNearGrade(reads: CompReadSample[], grade: number): number {
  return reads.filter((r) =>
    !r.stockRejected && r.readScore != null &&
    Math.abs(r.readScore - grade) <= GRADE_BUCKET_HALF_WIDTH
  ).length;
}

/**
 * Build the curve points for a measured cell. Pure.
 *
 * Points outside the observed grade range come back `sufficient: false` with a
 * null median, which is the same shape a seeded curve uses for a grade it could
 * not support, so the existing publish filter handles them with no new code.
 */
export function buildMeasuredCurvePoints(
  fit: CurveFit,
  score: HoldOutScore,
  reads: CompReadSample[],
  gradePoints: number[],
): CurvePoint[] {
  const band = Math.round(score.curveErrorCents);
  return gradePoints.map((grade) => {
    const inRange = grade >= fit.gradeMin && grade <= fit.gradeMax;
    if (!inRange) {
      return {
        grade,
        lowCents: null,
        medianCents: null,
        highCents: null,
        sampleSize: 0,
        sufficient: false,
      };
    }
    const median = priceAtGrade(fit, grade);
    return {
      grade,
      lowCents: Math.max(0, median - band),
      medianCents: median,
      highCents: median + band,
      sampleSize: readsNearGrade(reads, grade),
      sufficient: true,
    };
  });
}

/** Assemble the row without touching a database, so the shape can be tested. */
export function toMeasuredCurveRow(
  input: MeasuredCurveInput,
  gradePoints: number[],
): MeasuredCurveRow {
  const points = buildMeasuredCurvePoints(input.fit, input.score, input.reads, gradePoints);
  return {
    item_key: input.itemKey,
    slug: input.slug,
    label: input.label,
    brand: input.brand,
    category_id: input.categoryId,
    query: input.query,
    currency: input.currency,
    curve: points,
    total_sample_size: input.fit.sampleSize,
    refreshed_at: input.measuredAt,
    provenance: "measured",
    slope_cents_per_point: input.fit.slopeCentsPerPoint,
    fit_confidence: input.fit.fitConfidence,
    measured_at: input.measuredAt,
  };
}

/** The slice of supabase-js this module uses, injected so the write is testable. */
export interface CurveWriteClient {
  from(table: string): {
    upsert(
      row: MeasuredCurveRow,
      opts: { onConflict: string },
    ): Promise<{ error: { message: string } | null }>;
  };
}

/**
 * Write a measured curve over whatever is in the row today.
 *
 * A measured curve DOES overwrite a seeded one, deliberately and in this
 * direction only: measured is strictly better evidence than generated. The
 * refusal runs the other way, and lives in persistSeededCurve.
 */
export async function writeMeasuredCurve(
  client: CurveWriteClient,
  input: MeasuredCurveInput,
  gradePoints: number[],
): Promise<{ ok: boolean; error: string | null }> {
  const row = toMeasuredCurveRow(input, gradePoints);
  const { error } = await client
    .from("condition_price_curves")
    .upsert(row, { onConflict: "item_key" });
  return error ? { ok: false, error: error.message } : { ok: true, error: null };
}
