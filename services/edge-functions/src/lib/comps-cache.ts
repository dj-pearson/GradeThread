// US-2754: stop paying eBay twice for the same question.
//
// THE MOMENT THIS IS FOR. A reseller works a rack of six similar Carhartt
// jackets. Today each one is a fresh Browse call at full latency, even though
// the query — category, keyword, brand, condition — is identical for most of
// them. The second lookup should be instant, and the sixth should make Scout
// feel faster the longer they work rather than the same every time.
//
// WHAT IS CACHED, AND WHAT IS NOT. The key is the QUERY SHAPE and nothing else.
// Not the photo, not the grade, and above all not the tenant: comps are public
// market data, so every seller asking about the same jacket wants the same
// answer. A per-tenant key would multiply the misses and buy nothing.
//
// The cache is cluster-shared rather than a module-level Map, per the invariant
// in vault/10-ops/edge-runtime-invariants.md. Two replicas holding different
// comps for one query is not merely a lower hit rate — it is the same seller
// getting two prices for one jacket, which is how a number stops being trusted.

import { createSharedJsonCache } from "./coherent-cache.ts";
import { type BrowseCompsArgs, type BrowseCompsResult, searchBrowseComps } from "./ebay-client.ts";
import { gradeToConditionId } from "./repricing.ts";
import {
  applyMeasuredCurve,
  type ItemKey,
  type ValueAtGradeOptions,
} from "./condition-value.ts";
import { type ValueRange, valueRangeFromStats } from "./condition-value-math.ts";

/**
 * How long a comp result stands.
 *
 * Fifteen minutes. Long enough to cover a rack, an aisle, and the pause at the
 * fitting-room mirror — the repeats this exists for all happen inside one store
 * run. Short enough that no value shown to a seller is more than a quarter hour
 * old, which sits well inside the spread of a comp distribution and so cannot
 * move a buy-or-skip call on its own.
 *
 * Longer would be tempting and wrong: a price presented as current should be
 * current, and "we told you £40 because that was true at lunchtime" is not an
 * answer anyone wants after they have bought the thing.
 */
export const COMPS_CACHE_TTL_MS = 15 * 60 * 1000;

/** Fields that change the eBay query, and therefore change the answer. */
type KeyableArgs = Pick<
  BrowseCompsArgs,
  "categoryId" | "q" | "brand" | "size" | "conditionId" | "limit" | "gtin"
>;

function norm(v: string | undefined | null): string {
  return (v ?? "").trim().toLowerCase();
}

/**
 * A stable key for a comp query.
 *
 * Order-independent and case-insensitive, because a seller typing "Carhartt"
 * and "carhartt" is asking one question and eBay matches them the same way.
 * Two keys there would halve the hit rate for nothing.
 *
 * Every field that reaches the Browse query appears here. A field that changes
 * the result but not the key would serve one item's comps for another, which is
 * a wrong price rather than a slow one — much worse than a cache miss.
 */
export function compsCacheKey(args: KeyableArgs): string {
  return [
    `c=${norm(args.categoryId)}`,
    `q=${norm(args.q)}`,
    `b=${norm(args.brand)}`,
    `s=${norm(args.size)}`,
    `k=${norm(args.conditionId)}`,
    `g=${norm(args.gtin)}`,
    `n=${args.limit ?? ""}`,
  ].join("|");
}

const cache = createSharedJsonCache<BrowseCompsResult>({
  namespace: "comps",
  ttlMs: COMPS_CACHE_TTL_MS,
});

/**
 * searchBrowseComps, but a repeat within the TTL costs a Postgres read instead
 * of an eBay round trip.
 *
 * Deliberately a WRAPPER rather than caching inside searchBrowseComps itself.
 * That function is the eBay client's plain door and several callers use it for
 * things where freshness matters more than speed; making every one of them
 * cached silently is a bigger change than this story is asking for. Scout opts
 * in because Scout is the surface standing in a shop.
 *
 * `hit` is returned so the caller can record the real hit rate rather than
 * assume one.
 */
export async function cachedSearchBrowseComps(
  args: BrowseCompsArgs,
): Promise<{ result: BrowseCompsResult; hit: boolean }> {
  const key = compsCacheKey(args);
  const { value, hit } = await cache.get(key, () => searchBrowseComps(args));
  return { result: value, hit };
}

/**
 * `valueAtGrade`, served from the same cache.
 *
 * A comp query for a value range differs from the plain one in exactly one
 * field: the eBay condition the grade maps to. There are only a handful of
 * those, so a caller asking for a value at eight different grades is usually
 * asking eBay two or three distinct questions, not eight. Scout's scan was
 * paying full Browse latency for every candidate to learn that.
 *
 * The pure range maths stays in `condition-value-math.ts`; this only decides
 * where the comps come from.
 *
 * US-2849: it ends at the same choke point as the uncached path, so the scan
 * endpoint gets the measured range on the same flag as everything else. That
 * matters because scout's scan is the ONE surface that does not go through
 * valueAtGrade, and a flip that reached five surfaces out of six would price a
 * rack differently from the item the seller then opens.
 *
 * THE CACHE KEY IS UNCHANGED AND STAYS QUERY-SHAPED. applyMeasuredCurve runs
 * OUTSIDE cachedSearchBrowseComps, on the already-cached comp result, and its
 * own curve lookup is keyed by the market cell (brand, category, keyword). No
 * tenant enters either key, per the invariant at the top of this file.
 */
export async function cachedValueAtGrade(
  item: ItemKey,
  gradeValue: number | null,
  opts: ValueAtGradeOptions = {},
): Promise<ValueRange> {
  const { result } = await cachedSearchBrowseComps({
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
