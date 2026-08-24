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
  observeMeasuredShadow,
  shadowEnabled,
  type ShadowCurveClient,
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

  // US-2848 shadow. Compute the measured-curve answer beside the live one,
  // record the gap, and return the live one regardless. THIS AWAIT IS ONE
  // INDEXED, CACHED SUPABASE READ AND NO EBAY CALL, awaited rather than
  // fire-and-forget so US-2849 can flip which range is returned here without
  // moving a line, which is the whole point of doing it at this choke point.
  // observeMeasuredShadow swallows and counts every failure of its own, so
  // there is nothing here to catch; the try is belt-and-braces for a future
  // edit that forgets that contract.
  try {
    await observeMeasuredShadow(
      {
        read: supabaseAdmin as unknown as ShadowCurveClient,
        write: supabaseAdmin as unknown as ShadowWriteClient,
        enabled: shadowEnabled(),
      },
      item,
      gradeValue,
      live,
    );
  } catch {
    // Deliberately empty: the shadow must never decide a seller's request.
  }

  return live;
}
