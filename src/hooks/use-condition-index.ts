import { useQuery } from "@tanstack/react-query";
import { edgeApiUrl } from "@/lib/edge-api";
import type { ValueBasis } from "@/components/value/value-basis-note";

// US-848: bring the public Condition Index (US-621/622) authority data into the
// seller's pricing surfaces. The composer + item detail look up the grade-vs-
// value curve for an item (by brand + category) and show "your grade maps to
// ~$X median" with a deep link to the public /condition-index/<slug> page.
//
// We read the SAME public, unauthenticated endpoints the SEO pages use
// (/api/grading/public/condition-index[/:slug]) — aggregate, cross-tenant-safe
// data only (no per-user rows), and the lib already suppresses thin curves so a
// fabricated value never reaches us. Everything degrades silently to null when
// there's no matching curve.
//
// These are public + anonymous, so we hit the edge with a plain fetch rather
// than edgeFetch — deliberately: edgeFetch pulls in the Supabase client (auth
// session + gate UI), which would drag the whole auth graph into the prerender
// SSR bundle for the public /whats-it-worth page (US-849). edgeApiUrl() only
// resolves a base URL and is import-safe; it is called in the browser queryFn,
// never during SSR (React Query doesn't run queries while rendering to string).

function fetchPublic(path: string): Promise<Response> {
  return fetch(`${edgeApiUrl()}${path}`, {
    headers: { Accept: "application/json" },
  });
}

export interface ConditionIndexHubItem {
  slug: string;
  label: string;
  brand: string;
  currency: string;
  headlineMedianCents: number | null;
  totalSampleSize: number;
  refreshedAt: string;
  /** US-2850: what this curve is, worded by the edge. */
  disclosure?: ValueBasis;
}

export interface ConditionCurvePoint {
  grade: number;
  lowCents: number | null;
  medianCents: number | null;
  highCents: number | null;
  sampleSize: number;
}

export interface ConditionIndexCurve {
  slug: string;
  label: string;
  brand: string;
  categoryId: string;
  currency: string;
  points: ConditionCurvePoint[];
  totalSampleSize: number;
  refreshedAt: string;
  /** US-2850: what this curve is, worded by the edge. */
  disclosure?: ValueBasis;
}

// The Index changes slowly (cron-refreshed comps), so cache hard — the hub list
// is shared across the composer and every item detail page.
const INDEX_STALE_TIME = 60 * 60 * 1000; // 1 hour
const INDEX_GC_TIME = 2 * 60 * 60 * 1000; // 2 hours

/** The curated Condition Index hub list (every published curve). */
export function useConditionIndexHub() {
  return useQuery({
    queryKey: ["condition-index-hub"],
    staleTime: INDEX_STALE_TIME,
    gcTime: INDEX_GC_TIME,
    queryFn: async (): Promise<ConditionIndexHubItem[]> => {
      const res = await fetchPublic("/api/grading/public/condition-index");
      if (!res.ok) throw new Error("Failed to load Condition Index");
      const data = (await res.json().catch(() => null)) as
        | { items?: ConditionIndexHubItem[] }
        | null;
      return data?.items ?? [];
    },
  });
}

/** One Condition Index curve by slug, or null when absent / suppressed. */
export function useConditionIndexCurve(slug: string | null | undefined) {
  return useQuery({
    queryKey: ["condition-index-curve", slug],
    enabled: !!slug,
    staleTime: INDEX_STALE_TIME,
    gcTime: INDEX_GC_TIME,
    queryFn: async (): Promise<ConditionIndexCurve | null> => {
      const res = await fetchPublic(
        `/api/grading/public/condition-index/${encodeURIComponent(slug as string)}`,
      );
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as
        | { curve?: ConditionIndexCurve }
        | null;
      return data?.curve ?? null;
    },
  });
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Match an inventory item to a Condition Index entry. Pure + tested.
 *
 * Brand is REQUIRED (exact, case-insensitive) — without a brand match we never
 * show a value (no fabricated number). When a brand has several curves (e.g.
 * Patagonia Better Sweater vs Patagonia Jackets) we disambiguate by category +
 * title keyword overlap with each entry's label, tie-breaking on comp depth so
 * the deepest curve wins. The matched label is always shown to the user, so the
 * value is honestly attributed to the specific item it priced.
 */
export function matchConditionIndexEntry(
  items: ConditionIndexHubItem[],
  opts: { brand?: string | null; category?: string | null; title?: string | null },
): ConditionIndexHubItem | null {
  const brand = norm(opts.brand);
  if (!brand) return null;

  const candidates = items.filter((it) => norm(it.brand) === brand);
  const first = candidates[0];
  if (!first) return null;
  if (candidates.length === 1) return first;

  const haystack = `${norm(opts.category)} ${norm(opts.title)}`;
  let best = first;
  let bestScore = -1;
  for (const c of candidates) {
    // Score on the label's distinctive words (drop the brand itself + stop-ish
    // short tokens) appearing in the item's category/title.
    const words = norm(c.label)
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !brand.includes(w));
    let score = 0;
    for (const w of words) if (haystack.includes(w)) score += 1;
    if (
      score > bestScore ||
      (score === bestScore && c.totalSampleSize > best.totalSampleSize)
    ) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The curve point nearest a given grade (only points with a real median). Pure
 * + tested. Returns null when the grade is unknown or no point has data.
 */
export function curveMedianAtGrade(
  points: ConditionCurvePoint[],
  grade: number | null | undefined,
): ConditionCurvePoint | null {
  const valid = points.filter((p) => p.medianCents != null);
  const first = valid[0];
  if (!first || grade == null) return null;
  let best = first;
  for (const p of valid) {
    if (Math.abs(p.grade - grade) < Math.abs(best.grade - grade)) best = p;
  }
  return best;
}

/** Format integer cents in a currency for display, e.g. 4200 → "$42". */
export function formatCurveCents(cents: number, currency = "USD"): string {
  const fmt = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
  return fmt.format(cents / 100);
}
