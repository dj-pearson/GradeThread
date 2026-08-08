// US-1064: turn anonymized community benchmarks into actionable recommendations.
//
// The community_benchmarks RPC (00173, src/lib/community-benchmarks.ts) already
// returns k-anonymous cohort aggregates — top brands by sell-through, trending
// categories, and the caller's peer comparison. This module is a PURE,
// dependency-light derivation layer that turns those aggregates into concrete
// "source more of X" / "price your X near $Y" suggestions, each carrying its own
// confidence and the cohort size (distinct sellers) it was derived from so the
// reseller can judge how much weight to give it.
//
// Kept free of React / network so it is unit-testable and reusable by the full
// Community Insights page AND the dashboard widget. The iOS surface mirrors this
// exact logic in CommunityRecommendations.swift — keep the two in sync.

import { encodeQuery } from "@/lib/item-filter";
import type {
  BrandBenchmark,
  CategoryTrend,
  CommunityBenchmarks,
} from "@/lib/community-benchmarks";

export type RecommendationKind = "source" | "price";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface Recommendation {
  /** Stable id for React keys (kind + subject). */
  id: string;
  kind: RecommendationKind;
  /** The brand or category the recommendation is about. */
  subject: string;
  title: string;
  detail: string;
  /** 0–1 confidence, derived from cohort size + signal strength. */
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  /** Distinct sellers behind the cohort this was derived from. */
  cohortSize: number;
  /** In-app route to act on the recommendation (filtered inventory / comps). */
  deepLink: string;
  /** Short label for the deep-link CTA. */
  deepLinkLabel: string;
  /** Internal ranking score — higher first. Not for display. */
  score: number;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

/**
 * Confidence contributed purely by sample size. The RPC's k-anonymity floor is
 * 5 distinct sellers, so 5 maps to a deliberately modest 0.40 and it climbs to
 * 0.95 by ~23 sellers — more sellers behind a number, more trustworthy it is.
 */
export function cohortConfidence(sellers: number): number {
  return clamp(0.4 + (sellers - 5) * 0.03, 0.4, 0.95);
}

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.55) return "medium";
  return "low";
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const usd = (n: number): string => `$${n.toFixed(2)}`;

// ── Deep-link builders ──────────────────────────────────────────────────────

/** Comps scan prefilled with the brand (the "source more of X" action). */
export function sourceCompsLink(brand: string): string {
  // US-2161: ScoutAI is a Sourcing tab; the brand rides along in the query.
  return `/dashboard/flipdesk/sourcing?tab=scout&brand=${encodeURIComponent(brand)}`;
}

/** Inventory filtered to a single brand (so the seller can reprice their stock). */
export function inventoryBrandLink(brand: string): string {
  const filter = encodeQuery({
    combinator: "and",
    rules: [{ id: "rec-brand", field: "brand", op: "eq", value: brand }],
  });
  return `/dashboard/flipdesk/inventory?filter=${filter}`;
}

/** Inventory filtered to a single category. */
function inventoryCategoryLink(category: string): string {
  const filter = encodeQuery({
    combinator: "and",
    rules: [{ id: "rec-category", field: "category", op: "eq", value: category }],
  });
  return `/dashboard/flipdesk/inventory?filter=${filter}`;
}

// ── Derivation ──────────────────────────────────────────────────────────────

/** Minimum community sell-through before we suggest sourcing more of a brand. */
const SOURCE_SELL_THROUGH_FLOOR = 0.5;
/** Minimum 30d-over-30d growth before a category is "demand rising". */
const TRENDING_GROWTH_FLOOR = 0.15;

function brandSourceRec(b: BrandBenchmark): Recommendation | null {
  if (b.sellThrough == null || b.sellThrough < SOURCE_SELL_THROUGH_FLOOR) {
    return null;
  }
  const confidence = clamp(
    cohortConfidence(b.sellers) * (0.6 + 0.4 * Math.min(b.sellThrough, 1)),
    0,
    1,
  );
  const avg = b.avgSalePrice != null ? ` · avg sale ${usd(b.avgSalePrice)}` : "";
  return {
    id: `source-brand:${b.brand}`,
    kind: "source",
    subject: b.brand,
    title: `Source more ${b.brand}`,
    detail: `Sells through at ${pct(b.sellThrough)} across ${b.sellers} sellers${avg}`,
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    cohortSize: b.sellers,
    deepLink: sourceCompsLink(b.brand),
    deepLinkLabel: "Find comps",
    score: b.sellThrough * confidence,
  };
}

function brandPriceRec(b: BrandBenchmark): Recommendation | null {
  if (b.avgSalePrice == null || b.avgSalePrice <= 0) return null;
  const confidence = cohortConfidence(b.sellers);
  const st =
    b.sellThrough != null ? ` · ${pct(b.sellThrough)} sell-through` : "";
  return {
    id: `price-brand:${b.brand}`,
    kind: "price",
    subject: b.brand,
    title: `Price ${b.brand} near ${usd(b.avgSalePrice)}`,
    detail: `Community average sale across ${b.sellers} sellers${st}`,
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    cohortSize: b.sellers,
    deepLink: inventoryBrandLink(b.brand),
    deepLinkLabel: "Review your prices",
    score: confidence,
  };
}

function categorySourceRec(c: CategoryTrend): Recommendation | null {
  if (c.growth == null || c.growth < TRENDING_GROWTH_FLOOR) return null;
  const confidence = clamp(
    cohortConfidence(c.sellers) * (0.7 + 0.3 * Math.min(c.growth, 1)),
    0,
    1,
  );
  return {
    id: `source-category:${c.category}`,
    kind: "source",
    subject: c.category,
    title: `Demand rising in ${c.category}`,
    detail: `Sales up ${pct(c.growth)} over the last 30 days · ${c.sellers} sellers`,
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    cohortSize: c.sellers,
    deepLink: inventoryCategoryLink(c.category),
    deepLinkLabel: "View inventory",
    score: c.growth * confidence,
  };
}

/**
 * Derive a ranked list of sourcing & pricing recommendations from the community
 * benchmarks. Highest-scoring first; callers slice for compact surfaces.
 */
export function deriveRecommendations(
  data: CommunityBenchmarks,
): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const b of data.topBrands) {
    const s = brandSourceRec(b);
    if (s) recs.push(s);
    const p = brandPriceRec(b);
    if (p) recs.push(p);
  }
  for (const c of data.trendingCategories) {
    const r = categorySourceRec(c);
    if (r) recs.push(r);
  }
  return recs.sort((a, b) => b.score - a.score);
}
