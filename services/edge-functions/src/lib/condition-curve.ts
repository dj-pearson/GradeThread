// Persisted price-vs-grade curves (US-611).
//
// A curve evaluates the condition-value engine (US-610) across the grade scale
// for one item identity. We fetch comps once per DISTINCT conditionId bucket
// (typically 3 eBay calls: new-with-tags / new-without-tags / used) and then
// position a value range at each grade within its bucket — so a full curve costs
// ~3 Browse calls, not one per grade. Curves are cached in condition_price_curves
// (migration 00098) with a TTL so the public Index + ScoutAI reuse them.

import { supabaseAdmin } from "./supabase.ts";
import { gradeToConditionId } from "./repricing.ts";
import {
  type ItemKey,
  valueRangeFromStats,
} from "./condition-value.ts";
import { searchBrowseComps } from "./ebay-client.ts";
import { normalizeItemKey } from "./condition-item-key.ts";
import { captureException, logEvent } from "./observability.ts";

// Representative grade points for a curve (half-point steps at the top where
// condition buckets change, whole steps through the used band).
export const CURVE_GRADE_POINTS = [10, 9.5, 9, 8.5, 8, 7, 6, 5, 4, 3];

const CURVE_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days — comps drift slowly.

export interface CurvePoint {
  grade: number;
  lowCents: number | null;
  medianCents: number | null;
  highCents: number | null;
  sampleSize: number;
  sufficient: boolean;
}

export interface ValueCurve {
  itemKey: string;
  brand: string | null;
  categoryId: string;
  query: string | null;
  currency: string;
  points: CurvePoint[];
  totalSampleSize: number;
  refreshedAt: string;
}

// Normalized, stable identity for an item across lookups. Defined in
// condition-item-key.ts (US-2848) so condition-value.ts can build the same key
// without importing this module back; re-exported here so nothing moved.
export { type ItemIdentity, normalizeItemKey } from "./condition-item-key.ts";

// Injectable comp fetcher (mirrors the codebase's injectable-deps pattern) so
// buildValueCurve is unit-testable without eBay.
export type CompFetcher = typeof searchBrowseComps;

/**
 * Build a full price-vs-grade curve for an item. Fetches comps once per distinct
 * conditionId bucket, then positions a value range at each grade point.
 */
export async function buildValueCurve(
  item: ItemKey,
  fetcher: CompFetcher = searchBrowseComps,
  limitPerBucket = 25,
): Promise<ValueCurve> {
  const distinctConditionIds = [
    ...new Set(CURVE_GRADE_POINTS.map((g) => gradeToConditionId(g))),
  ];

  // One fetch per bucket; a failed bucket degrades to empty stats (its grades
  // become insufficient) rather than failing the whole curve.
  const buckets = new Map<string, Awaited<ReturnType<CompFetcher>>["stats"]>();
  let currency = "USD";
  for (const conditionId of distinctConditionIds) {
    try {
      const res = await fetcher({
        categoryId: item.categoryId,
        q: item.q,
        brand: item.brand,
        size: item.size,
        conditionId,
        limit: Math.min(Math.max(limitPerBucket, 1), 50),
      });
      buckets.set(conditionId, res.stats);
      if (res.stats.currency) currency = res.stats.currency;
    } catch (err) {
      captureException(err, { route: "condition-curve.fetch", tags: { conditionId } });
      buckets.set(conditionId, {
        count: 0, currency, min: null, p25: null, median: null, p75: null, max: null,
      });
    }
  }

  const points: CurvePoint[] = CURVE_GRADE_POINTS.map((grade) => {
    const stats = buckets.get(gradeToConditionId(grade)) ?? {
      count: 0, currency, min: null, p25: null, median: null, p75: null, max: null,
    };
    const r = valueRangeFromStats(stats, grade, currency);
    return {
      grade,
      lowCents: r.lowCents,
      medianCents: r.medianCents,
      highCents: r.highCents,
      sampleSize: r.sampleSize,
      sufficient: r.sufficient,
    };
  });

  // US-1947: comps are fetched per condition BUCKET and value is positioned per
  // grade within a bucket, which can INVERT across buckets (a higher grade worth
  // less than a lower one when the better condition has thinner/cheaper comps).
  // A better grade must never be valued below a worse one — enforce it.
  enforceGradeMonotonic(points);

  // Distinct buckets → sum each bucket's count once (grades share buckets).
  const totalSampleSize = [...buckets.values()].reduce((sum, s) => sum + s.count, 0);

  return {
    itemKey: normalizeItemKey(item),
    brand: item.brand ?? null,
    categoryId: item.categoryId,
    query: item.q ?? null,
    currency,
    points,
    totalSampleSize,
    refreshedAt: new Date().toISOString(),
  };
}

/**
 * US-1947: make a value curve monotonic in grade. Because comps are bucketed by
 * eBay condition, a naive per-grade value can invert across buckets — but a
 * better condition grade must never be worth less than a worse one. We clamp
 * each field (low/median/high) to a running maximum as grade increases, lifting
 * any inverted higher grade up to the floor the lower grades set, then keep each
 * point internally ordered (low ≤ median ≤ high). Null (insufficient) points are
 * left untouched. Mutates in place. Exported for unit testing.
 */
export function enforceGradeMonotonic(points: CurvePoint[]): void {
  const asc = [...points].sort((a, b) => a.grade - b.grade);
  let lo = -Infinity;
  let med = -Infinity;
  let hi = -Infinity;
  for (const p of asc) {
    if (p.lowCents != null) {
      lo = Math.max(lo, p.lowCents);
      p.lowCents = lo;
    }
    if (p.medianCents != null) {
      med = Math.max(med, p.medianCents);
      p.medianCents = med;
    }
    if (p.highCents != null) {
      hi = Math.max(hi, p.highCents);
      p.highCents = hi;
    }
    // Keep the range internally consistent after clamping.
    if (p.lowCents != null && p.medianCents != null) {
      p.lowCents = Math.min(p.lowCents, p.medianCents);
    }
    if (p.highCents != null && p.medianCents != null) {
      p.highCents = Math.max(p.highCents, p.medianCents);
    }
  }
}

interface CurveRow {
  item_key: string;
  brand: string | null;
  category_id: string;
  query: string | null;
  currency: string;
  curve: CurvePoint[];
  total_sample_size: number;
  refreshed_at: string;
}

function rowToCurve(row: CurveRow): ValueCurve {
  return {
    itemKey: row.item_key,
    brand: row.brand,
    categoryId: row.category_id,
    query: row.query,
    currency: row.currency,
    points: row.curve,
    totalSampleSize: row.total_sample_size,
    refreshedAt: row.refreshed_at,
  };
}

/** Read the cached curve for an item, or null if absent. */
export async function readCachedCurve(item: ItemKey): Promise<ValueCurve | null> {
  const { data } = await supabaseAdmin
    .from("condition_price_curves")
    .select("item_key, brand, category_id, query, currency, curve, total_sample_size, refreshed_at")
    .eq("item_key", normalizeItemKey(item))
    .maybeSingle();
  return data ? rowToCurve(data as CurveRow) : null;
}

/**
 * Return a fresh-enough curve: serve the cache if it's within the TTL, else
 * rebuild from comps and persist. Pass forceRefresh to always rebuild (e.g. a
 * scheduled refresh). Falls back to a stale cached curve if a rebuild fails.
 */
export async function getOrRefreshCurve(
  item: ItemKey,
  opts: { ttlMs?: number; forceRefresh?: boolean; fetcher?: CompFetcher } = {},
): Promise<ValueCurve> {
  const ttl = opts.ttlMs ?? CURVE_TTL_MS;
  const cached = await readCachedCurve(item);
  if (!opts.forceRefresh && cached) {
    const age = Date.now() - new Date(cached.refreshedAt).getTime();
    if (age < ttl) return cached;
  }

  let curve: ValueCurve;
  try {
    curve = await buildValueCurve(item, opts.fetcher ?? searchBrowseComps);
  } catch (err) {
    captureException(err, { route: "condition-curve.build" });
    if (cached) return cached; // serve stale rather than fail
    throw err;
  }

  const { error } = await supabaseAdmin
    .from("condition_price_curves")
    .upsert(
      {
        item_key: curve.itemKey,
        brand: curve.brand,
        category_id: curve.categoryId,
        query: curve.query,
        currency: curve.currency,
        curve: curve.points,
        total_sample_size: curve.totalSampleSize,
        refreshed_at: curve.refreshedAt,
      },
      { onConflict: "item_key" },
    );
  if (error) logEvent("warn", "condition-curve.persist_failed", { itemKey: curve.itemKey });
  return curve;
}
