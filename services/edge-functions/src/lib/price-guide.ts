// Resale Condition Index — Price Guide (US-1285).
//
// Turns the proprietary Condition Index (price-vs-grade curves, US-621) plus the
// State-of-Resale-Condition aggregates (sell-through by grade band, US-976) into
// a single QUERYABLE price-guide product: for a published brand/category item,
// what is the resale VALUE RANGE and SELL-THROUGH at each condition-grade band?
//
// It is built entirely on top of already-public, already-aggregated, already-
// sample-gated data:
//   • value range per band  ← the Condition Index curve (toDto already drops any
//     grade point without real comp support, so a band with no sufficient point
//     is OMITTED here — the "no data → not shown" rule is inherited, not bypassed)
//   • sell-through per band ← the platform-wide resale-condition report (each
//     rate is null until its band clears RESALE_MIN_SAMPLE)
//
// Nothing per-user / per-item / PII can reach this surface: it reads ONLY the
// curated curve DTOs and the platform aggregate rollup, never raw rows.

import {
  getIndexCurveBySlug,
  getIndexHub,
  type IndexCurveDto,
} from "./condition-index.ts";
import {
  bandForGrade,
  computeResaleConditionReport,
  type ResaleBandKey,
  type ResaleConditionBand,
} from "./resale-condition.ts";

// The three graded bands, published best-condition-first (mirrors the resale
// report's BAND_ORDER; the "ungraded" band is meaningless for a price guide).
const PRICE_GUIDE_BANDS: Array<{
  key: ResaleBandKey;
  label: string;
  gradeRange: string;
}> = [
  { key: "high", label: "Excellent & up", gradeRange: "8.5 – 10.0" },
  { key: "mid", label: "Good – Very Good", gradeRange: "6.5 – 8.0" },
  { key: "low", label: "Fair & below", gradeRange: "6.0 or lower" },
];

export interface PriceGuideBand {
  band: ResaleBandKey;
  label: string;
  gradeRange: string;
  currency: string;
  // Resale value range for this band, from the item's Condition Index curve.
  valueLowCents: number | null;
  valueMedianCents: number | null;
  valueHighCents: number | null;
  valueSampleSize: number;
  // Sell-through + median time-to-sell for this band. PLATFORM-WIDE (not brand-
  // specific) and sample-gated — null until the band clears the minimum sample.
  sellThrough: number | null;
  medianDaysToSell: number | null;
}

export interface PriceGuideEntry {
  slug: string;
  brand: string;
  label: string;
  categoryId: string;
  currency: string;
  refreshedAt: string;
  totalSampleSize: number;
  // Only bands with a published (sufficiently-sampled) value range appear.
  bands: PriceGuideBand[];
  // Honesty marker: value ranges are item-specific; the sell-through/time-to-sell
  // signals are platform-wide aggregates, not specific to this brand/category.
  sellThroughScope: "platform";
}

export interface PriceGuideCatalogItem {
  slug: string;
  brand: string;
  label: string;
  currency: string;
  headlineMedianCents: number | null;
  totalSampleSize: number;
  refreshedAt: string;
}

type CurvePoints = IndexCurveDto["points"];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

/**
 * Pure: fold a published Condition Index curve (per-grade value points, already
 * sample-suppressed by toDto) into the three grade bands, attaching the
 * platform-wide sell-through / time-to-sell for each band. A band with no
 * sufficient value point is OMITTED (no data → not shown). Exported for unit
 * testing without eBay or the DB.
 */
export function foldCurveToBands(
  points: CurvePoints,
  currency: string,
  resaleBands: ResaleConditionBand[],
): PriceGuideBand[] {
  const resaleByKey = new Map<ResaleBandKey, ResaleConditionBand>();
  for (const b of resaleBands) resaleByKey.set(b.key, b);

  const out: PriceGuideBand[] = [];
  for (const def of PRICE_GUIDE_BANDS) {
    const inBand = points.filter(
      (p) => bandForGrade(p.grade) === def.key && p.medianCents != null,
    );
    if (inBand.length === 0) continue; // no data → not shown (US-622 rule)

    const lows = inBand
      .map((p) => p.lowCents)
      .filter((v): v is number => v != null);
    const highs = inBand
      .map((p) => p.highCents)
      .filter((v): v is number => v != null);
    const medians = inBand
      .map((p) => p.medianCents)
      .filter((v): v is number => v != null);
    const resale = resaleByKey.get(def.key);

    out.push({
      band: def.key,
      label: def.label,
      gradeRange: def.gradeRange,
      currency,
      valueLowCents: lows.length ? Math.min(...lows) : null,
      valueMedianCents: median(medians),
      valueHighCents: highs.length ? Math.max(...highs) : null,
      valueSampleSize: inBand.reduce((n, p) => n + (p.sampleSize ?? 0), 0),
      sellThrough: resale?.sell_through ?? null,
      medianDaysToSell: resale?.median_days_to_sell ?? null,
    });
  }
  return out;
}

/** Pure: assemble a full price-guide entry from a curve DTO + resale bands. */
export function buildPriceGuideEntry(
  curve: IndexCurveDto,
  resaleBands: ResaleConditionBand[],
): PriceGuideEntry {
  return {
    slug: curve.slug,
    brand: curve.brand,
    label: curve.label,
    categoryId: curve.categoryId,
    currency: curve.currency,
    refreshedAt: curve.refreshedAt,
    totalSampleSize: curve.totalSampleSize,
    bands: foldCurveToBands(curve.points, curve.currency, resaleBands),
    sellThroughScope: "platform",
  };
}

// The resale-condition rollup scans items_full (heavy) and moves slowly, so the
// platform-wide band signals are cached per edge instance (mirrors the public
// route's resaleCache TTL). A scan failure degrades to no sell-through data, not
// an error — the value ranges still publish.
const RESALE_BANDS_TTL_MS = 15 * 60 * 1000;
let resaleBandsCache: { at: number; bands: ResaleConditionBand[] } | null = null;

async function getResaleBandsCached(): Promise<ResaleConditionBand[]> {
  const now = Date.now();
  if (!resaleBandsCache || now - resaleBandsCache.at > RESALE_BANDS_TTL_MS) {
    try {
      const report = await computeResaleConditionReport();
      resaleBandsCache = { at: now, bands: report.bands };
    } catch {
      // Serve a stale copy if we have one; otherwise no platform signal (value
      // ranges still render). Never propagate the scan error to the API caller.
      if (!resaleBandsCache) return [];
    }
  }
  return resaleBandsCache?.bands ?? [];
}

/** Queryable catalog: every published (sufficiently-sampled) price-guide item. */
export async function getPriceGuideCatalog(): Promise<PriceGuideCatalogItem[]> {
  const hub = await getIndexHub();
  return hub.map((h) => ({
    slug: h.slug,
    brand: h.brand,
    label: h.label,
    currency: h.currency,
    headlineMedianCents: h.headlineMedianCents,
    totalSampleSize: h.totalSampleSize,
    refreshedAt: h.refreshedAt,
  }));
}

/**
 * One queryable price-guide entry by slug, or null if the item has no published
 * curve (thin data is suppressed by getIndexCurveBySlug — US-622).
 */
export async function getPriceGuideEntry(
  slug: string,
): Promise<PriceGuideEntry | null> {
  const curve = await getIndexCurveBySlug(slug);
  if (!curve) return null;
  const resaleBands = await getResaleBandsCached();
  return buildPriceGuideEntry(curve, resaleBands);
}

// ── Sandbox (US-1285) ───────────────────────────────────────────────────────
// A free, deterministic mock of the price-guide API so partners can build an
// integration with no live data dependency. Same auth/scope/envelope as the live
// endpoints; results are derived purely from the slug (no DB read).

// Stable 0..1 hash of a seed string (FNV-1a) — mirrors api-v1.ts sandboxSeed.
function sandboxSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/** Deterministic sample price-guide entry for the sandbox (no credits, no DB). */
export function sandboxPriceGuideEntry(slug: string): PriceGuideEntry {
  const seed = slug || "sample-item";
  const s = sandboxSeed(seed);
  const base = 4000 + Math.round(s * 8000); // anchor median, cents
  // Higher condition → higher value, higher sell-through, faster sale.
  const tiers: Array<{
    def: (typeof PRICE_GUIDE_BANDS)[number];
    valueMult: number;
    sellThrough: number;
    days: number;
  }> = [
    { def: PRICE_GUIDE_BANDS[0]!, valueMult: 1.0, sellThrough: 0.78, days: 9 },
    { def: PRICE_GUIDE_BANDS[1]!, valueMult: 0.7, sellThrough: 0.61, days: 16 },
    { def: PRICE_GUIDE_BANDS[2]!, valueMult: 0.45, sellThrough: 0.42, days: 27 },
  ];
  const bands: PriceGuideBand[] = tiers.map((t) => {
    const mid = Math.round(base * t.valueMult);
    return {
      band: t.def.key,
      label: t.def.label,
      gradeRange: t.def.gradeRange,
      currency: "USD",
      valueLowCents: Math.round(mid * 0.82),
      valueMedianCents: mid,
      valueHighCents: Math.round(mid * 1.2),
      valueSampleSize: 12 + Math.round(s * 20),
      sellThrough: t.sellThrough,
      medianDaysToSell: t.days,
    };
  });
  return {
    slug: seed,
    brand: "Sample Brand",
    label: "Sample Brand Item",
    categoryId: "0",
    currency: "USD",
    refreshedAt: "2026-01-01T00:00:00.000Z",
    totalSampleSize: bands.reduce((n, b) => n + b.valueSampleSize, 0),
    bands,
    sellThroughScope: "platform",
  };
}

/** Deterministic sample catalog for the sandbox. */
export function sandboxPriceGuideCatalog(): PriceGuideCatalogItem[] {
  return [
    {
      slug: "sample-item",
      brand: "Sample Brand",
      label: "Sample Brand Item",
      currency: "USD",
      headlineMedianCents: 8200,
      totalSampleSize: 64,
      refreshedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}
