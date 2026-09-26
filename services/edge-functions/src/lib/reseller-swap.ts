// US-3541: Reseller Swap. Pure matching logic; the route does the reads.
//
// The idea in one line: seller A's eBay listing has sat past A's own "stale"
// line, and seller B's sales history says B sells that brand fast. Show B a tip
// that links to A's eBay listing. B buys it on eBay like any buyer would.
//
// What leaves this file is chosen for privacy (vault/20-domain/reseller-swap.md):
//   * A tip carries only what A's public eBay listing already shows: title,
//     brand, size, price, photo, how long it has been listed, and A's public
//     grade. It never carries A's user id, cost, profit or sales numbers.
//   * The "fit" on a tip is B's OWN numbers (how many of this brand B sold, how
//     fast). B's numbers are never shown to A or to anyone else.

/** How far back a seller's sales count toward their fit profile. */
export const FIT_WINDOW_DAYS = 180;
/** A brand needs at least this many sales in the window to count as a fit. */
export const MIN_FIT_SALES = 2;
/** ...and, when days-to-sell is known, a median at or under this. */
export const MAX_FIT_MEDIAN_DAYS = 30;
/** The floor for any seller's "stale after" setting (matches the DB CHECK). */
export const MIN_STALE_DAYS = 14;
export const MAX_STALE_DAYS = 365;
export const DEFAULT_STALE_DAYS = 60;
export const MAX_TIPS = 20;

const DAY_MS = 86_400_000;

/** Normalize a brand for matching: "Levi's" and "LEVIS" are the same brand. */
export function brandKey(brand: string | null | undefined): string | null {
  if (!brand) return null;
  const k = brand.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
  return k.length > 0 ? k : null;
}

export interface SaleSignal {
  brand: string | null;
  listedAt: string | null;
  soldAt: string;
}

export interface BrandFit {
  brand: string;
  sold: number;
  /** Median days from listing to sale, or null when no sale had a listing date. */
  medianDays: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * The brands a seller moves fast, keyed by brandKey. A brand qualifies with
 * MIN_FIT_SALES sales and, if any of them had a listing date, a median
 * days-to-sell at or under MAX_FIT_MEDIAN_DAYS.
 */
export function buildFitProfile(
  sales: SaleSignal[],
  opts: { minSales?: number; maxMedianDays?: number } = {},
): Map<string, BrandFit> {
  const minSales = opts.minSales ?? MIN_FIT_SALES;
  const maxMedian = opts.maxMedianDays ?? MAX_FIT_MEDIAN_DAYS;
  const byKey = new Map<
    string,
    { brand: string; sold: number; days: number[] }
  >();
  for (const s of sales) {
    const key = brandKey(s.brand);
    if (!key) continue;
    const entry = byKey.get(key) ??
      { brand: s.brand!.trim(), sold: 0, days: [] };
    entry.sold += 1;
    if (s.listedAt) {
      const d = (Date.parse(s.soldAt) - Date.parse(s.listedAt)) / DAY_MS;
      if (Number.isFinite(d)) entry.days.push(Math.max(0, Math.round(d)));
    }
    byKey.set(key, entry);
  }
  const out = new Map<string, BrandFit>();
  for (const [key, e] of byKey) {
    if (e.sold < minSales) continue;
    const med = median(e.days);
    if (med !== null && med > maxMedian) continue;
    out.set(key, { brand: e.brand, sold: e.sold, medianDays: med });
  }
  return out;
}

export function clampStaleDays(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n)
    ? Math.round(n)
    : DEFAULT_STALE_DAYS;
  return Math.min(MAX_STALE_DAYS, Math.max(MIN_STALE_DAYS, v));
}

/** A shared, active eBay listing from some OTHER seller. Internal to the edge. */
export interface SwapCandidate {
  itemId: string;
  ownerId: string;
  ownerStaleDays: number;
  title: string;
  brand: string | null;
  size: string | null;
  priceCents: number | null;
  listedAt: string;
  gradeValue: number | null;
  gradeLabel: string | null;
  photoUrl: string | null;
  url: string;
}

/** What the caller sees. No owner id, by construction. */
export interface SwapTip {
  item_id: string;
  title: string;
  brand: string;
  size: string | null;
  price_cents: number | null;
  days_listed: number;
  grade_value: number | null;
  grade_label: string | null;
  photo_url: string | null;
  url: string;
  fit: { sold: number; median_days: number | null };
}

/**
 * Pick and order the tips for one caller. `excludeOwnerIds` must hold the
 * caller's own tenant id, so a seller is never tipped their own stock.
 */
export function rankTips(
  candidates: SwapCandidate[],
  profile: Map<string, BrandFit>,
  opts: {
    excludeOwnerIds: Set<string>;
    dismissed: Set<string>;
    now?: number;
    limit?: number;
  },
): SwapTip[] {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? MAX_TIPS;
  const scored: Array<{ tip: SwapTip; fit: BrandFit; days: number }> = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (opts.excludeOwnerIds.has(c.ownerId)) continue;
    if (opts.dismissed.has(c.itemId) || seen.has(c.itemId)) continue;
    const key = brandKey(c.brand);
    const fit = key ? profile.get(key) : undefined;
    if (!fit) continue;
    const listed = Date.parse(c.listedAt);
    if (!Number.isFinite(listed)) continue;
    const days = Math.floor((now - listed) / DAY_MS);
    if (days < clampStaleDays(c.ownerStaleDays)) continue;
    seen.add(c.itemId);
    scored.push({
      fit,
      days,
      tip: {
        item_id: c.itemId,
        title: c.title,
        brand: c.brand!.trim(),
        size: c.size,
        price_cents: c.priceCents,
        days_listed: days,
        grade_value: c.gradeValue,
        grade_label: c.gradeLabel,
        photo_url: c.photoUrl,
        url: c.url,
        fit: { sold: fit.sold, median_days: fit.medianDays },
      },
    });
  }
  scored.sort((a, b) =>
    b.fit.sold - a.fit.sold ||
    (a.fit.medianDays ?? Infinity) - (b.fit.medianDays ?? Infinity) ||
    b.days - a.days ||
    a.tip.item_id.localeCompare(b.tip.item_id)
  );
  return scored.slice(0, limit).map((s) => s.tip);
}
