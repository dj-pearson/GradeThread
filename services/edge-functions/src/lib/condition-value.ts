// Condition-adjusted value engine (US-610).
//
// The moat: a GradeThread grade is an objective condition signal, so we can ask
// a question nobody else can — "what is THIS item worth AT THIS CONDITION?" —
// by pulling condition-matched eBay comps (conditionId derived from the grade)
// and positioning a value range within that distribution by grade.
//
// This is the shared foundation for Snap-to-Value (US-612), ScoutAI margin
// ranking (US-617), and the public Condition Index (US-621). The range math is
// a PURE function (valueRangeFromStats) so it's unit-tested without eBay; the
// thin I/O wrapper (valueAtGrade) fetches the condition-matched comps first.

import { gradeToConditionId } from "./repricing.ts";
import { searchBrowseComps } from "./ebay-client.ts";
import { supabaseAdmin } from "./supabase.ts";
import {
  measuredFlipEnabled,
  observeMeasuredShadow,
  type ShadowCurveClient,
  shadowEnabled,
  type ShadowWriteClient,
} from "./condition-value-shadow.ts";
// US-2237: the pure range maths lives in its own module so callers that only
// need the arithmetic (the scan endpoint's tests, for one) don't drag the eBay
// client in with it. Re-exported here so this file stays the front door.
import { type ValueRange, valueRangeFromStats } from "./condition-value-math.ts";
export {
  MIN_VALUE_COMPS,
  type ValueRange,
  valueRangeFromStats,
} from "./condition-value-math.ts";

// Identifies the item to comp against. categoryId is required by eBay Browse;
// brand + a keyword query sharpen the match.
export interface ItemKey {
  categoryId: string;
  q?: string;
  brand?: string;
  size?: string;
}

export interface ValueAtGradeOptions {
  /** Comp sample size to request from eBay Browse (capped 1..50). Default 25. */
  limit?: number;
}

/**
 * Fetch condition-matched comps for an item at a given grade and return the
 * condition-adjusted value range. The single eBay Browse call already runs
 * through the timeout + circuit breaker (ebay-client). Returns a sufficient:false
 * range rather than throwing when comps are too thin.
 */
export async function valueAtGrade(
  item: ItemKey,
  gradeValue: number | null,
  opts: ValueAtGradeOptions = {},
): Promise<ValueRange> {
  const result = await searchBrowseComps({
    categoryId: item.categoryId,
    q: item.q,
    brand: item.brand,
    size: item.size,
    conditionId: gradeToConditionId(gradeValue),
    limit: Math.min(Math.max(opts.limit ?? 25, 1), 50),
  });
  const live = valueRangeFromStats(result.stats, gradeValue, result.stats.currency);
  return await applyMeasuredCurve(item, gradeValue, live);
}

/**
 * THE CHOKE POINT (US-2848 shadow, US-2849 flip).
 *
 * Every condition-adjusted price the product quotes passes through here, which
 * is the entire reason the flip is one story and not six. valueAtGrade and
 * comps-cache's cachedValueAtGrade both call it, so routes/grade.ts,
 * routes/public-grading.ts, routes/flipdesk-scout.ts, routes/flipdesk-pricing.ts
 * and lib/grade-band-pricing.ts get the measured number without a line changing
 * in any of them.
 *
 * COSTS ONE SUPABASE READ AND NO EBAY CALL. The curve lookup is indexed and
 * sits behind a five-minute cache keyed by the market cell, which is
 * query-shaped and carries no tenant, exactly like the comps cache it runs
 * beside.
 *
 * NEVER THROWS AND NEVER RAISES A PRICE IT CANNOT STAND BEHIND. Anything going
 * wrong falls back to `live`, which is today's answer. The try below is
 * belt-and-braces: observeMeasuredShadow already swallows and counts its own
 * failures, and this catches an edit that forgets that contract.
 */
export interface MeasuredCurveOverrides {
  read?: ShadowCurveClient;
  write?: ShadowWriteClient;
  flip?: boolean;
  record?: boolean;
}

export async function applyMeasuredCurve(
  item: ItemKey,
  gradeValue: number | null,
  live: ValueRange,
  overrides: MeasuredCurveOverrides = {},
): Promise<ValueRange> {
  const flip = overrides.flip ?? measuredFlipEnabled();
  const record = overrides.record ?? shadowEnabled();
  // The flip implies the lookup. Turning the recording off must never quietly
  // disarm a flip somebody deliberately turned on. Both off is the only way to
  // skip the read entirely.
  if (!flip && !record) return live;
  try {
    const outcome = await observeMeasuredShadow(
      {
        read: overrides.read ?? (supabaseAdmin as unknown as ShadowCurveClient),
        write: overrides.write ?? (supabaseAdmin as unknown as ShadowWriteClient),
        enabled: true,
        record,
        flip,
      },
      item,
      gradeValue,
      live,
    );
    return outcome.range;
  } catch {
    return live;
  }
}
