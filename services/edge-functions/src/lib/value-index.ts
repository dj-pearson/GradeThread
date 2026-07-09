// Value Index URL space (US-1747).
//
// A brand+item(+condition)-structured public view over the SAME data as the
// Condition Index (condition_price_curves / condition-index.ts). Where the
// Condition Index is keyed by an opaque slug (/condition-index/<slug>), the
// Value Index projects each curve onto an exact-match URL a searcher actually
// types: /value/{brand}/{item} and /value/{brand}/{item}/{condition}. No new
// data — this is a resolver + URL model over the existing published curves, so
// it inherits the same MIN_INDEX_TOTAL_SAMPLE suppression (never a thin page).

import {
  getIndexCurveBySlug,
  getIndexHub,
  type IndexCurveDto,
  type IndexHubItem,
} from "./condition-index.ts";

/** Lowercase, hyphenated URL slug from an arbitrary label. Pure. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Derive the item slug from a curve's slug by stripping the brand prefix — the
 * curated slugs are `${brandSlug}-${itemSlug}` (e.g. "patagonia-better-sweater",
 * brand "Patagonia" → "better-sweater"). Falls back to the whole slug when it
 * doesn't carry the brand prefix. Pure.
 */
export function itemSlugFromCurve(curveSlug: string, brand: string): string {
  const bs = slugify(brand);
  if (bs && curveSlug.startsWith(`${bs}-`)) {
    return curveSlug.slice(bs.length + 1);
  }
  return curveSlug;
}

// The public condition bands the /value/{...}/{condition} URLs address, each
// anchored to a representative grade on the 1.0–10.0 scale (matches the
// grade-checker's public bands: 7.5+ Excellent, 6–7 Very Good, 4.5–5.5 Good).
export interface ConditionTier {
  slug: string;
  label: string;
  /** Representative grade used to pick the nearest curve point. */
  grade: number;
}

export const CONDITION_TIERS: ConditionTier[] = [
  { slug: "new", label: "New / like-new", grade: 9.5 },
  { slug: "excellent", label: "Excellent", grade: 8 },
  { slug: "very-good", label: "Very Good", grade: 6.5 },
  { slug: "good", label: "Good", grade: 5 },
  { slug: "fair", label: "Fair", grade: 4 },
];

export function conditionTierBySlug(slug: string): ConditionTier | null {
  return CONDITION_TIERS.find((t) => t.slug === slug) ?? null;
}

export type CurvePoint = IndexCurveDto["points"][number];

/** The published curve point nearest a target grade, or null when none. Pure. */
export function nearestPointForGrade(
  points: CurvePoint[],
  grade: number,
): CurvePoint | null {
  let best: CurvePoint | null = null;
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(p.grade - grade);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/** Public Value Index URL for a brand/item(+condition). Pure. */
export function valuePath(
  brandSlug: string,
  itemSlug: string,
  conditionSlug?: string,
): string {
  const base = `/value/${brandSlug}/${itemSlug}`;
  return conditionSlug ? `${base}/${conditionSlug}` : base;
}

export interface ValueHubItem extends IndexHubItem {
  brandSlug: string;
  itemSlug: string;
}

/** The Value Index hub: every published curve, tagged with its brand/item slugs. */
export async function getValueHub(): Promise<ValueHubItem[]> {
  const items = await getIndexHub();
  return items.map((it) => ({
    ...it,
    brandSlug: slugify(it.brand || it.slug),
    itemSlug: itemSlugFromCurve(it.slug, it.brand),
  }));
}

export interface ResolvedValueCurve {
  curve: IndexCurveDto;
  brandSlug: string;
  itemSlug: string;
}

/**
 * Resolve /value/{brand}/{item} to its published curve, or null when no curve
 * matches (or it's suppressed for thin data). Case-insensitive on the slugs.
 */
export async function resolveValueCurve(
  brandParam: string,
  itemParam: string,
): Promise<ResolvedValueCurve | null> {
  const brandSlug = slugify(brandParam);
  const itemSlug = slugify(itemParam);
  if (!brandSlug || !itemSlug) return null;

  const hub = await getValueHub();
  const match = hub.find((it) => it.brandSlug === brandSlug && it.itemSlug === itemSlug);
  if (!match) return null;

  const curve = await getIndexCurveBySlug(match.slug);
  if (!curve) return null;
  return { curve, brandSlug: match.brandSlug, itemSlug: match.itemSlug };
}

export interface ValueSitemapUrl {
  brandSlug: string;
  itemSlug: string;
  refreshedAt: string;
}

/**
 * Bounded set of Value Index URLs for the sitemap — only curves with real comp
 * depth (getValueHub already filters to MIN_INDEX_TOTAL_SAMPLE). Returns the
 * base brand/item URLs; per-condition URLs multiply by CONDITION_TIERS.
 */
export async function listValueSitemapUrls(): Promise<ValueSitemapUrl[]> {
  const hub = await getValueHub();
  return hub.map((it) => ({
    brandSlug: it.brandSlug,
    itemSlug: it.itemSlug,
    refreshedAt: it.refreshedAt,
  }));
}
