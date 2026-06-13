// Public Condition Index (US-621/622).
//
// "The S&P 500 of secondhand condition" — public, crawlable pages showing the
// price-vs-grade curve for popular items. The Index shows ONLY a curated set of
// brand/category entries (CURATED_INDEX), each refreshed by a cron, so every
// public page has real comp depth. Curves with too little data are suppressed
// (US-622) — no false precision ever reaches the SEO surface.

import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";
import { acquireJobLock } from "./job-lock.ts";
import {
  buildValueCurve,
  type CurvePoint,
  normalizeItemKey,
} from "./condition-curve.ts";
import { captureException, logEvent } from "./observability.ts";

// Curated Index entries. categoryId is an eBay leaf/level the Browse comps come
// from; slug is the public URL. Keep this list tight + high-traffic.
export interface IndexSeed {
  slug: string;
  label: string;
  brand: string;
  categoryId: string;
  q?: string;
}

// Fallback catalog. The live catalog now lives in the condition_index_seeds
// table (US-845) so it can grow without a deploy; this array is used ONLY when
// the table is empty (fresh DB / migration not yet applied) so the Index never
// goes dark.
export const CURATED_INDEX: IndexSeed[] = [
  { slug: "patagonia-better-sweater", label: "Patagonia Better Sweater", brand: "Patagonia", categoryId: "11450", q: "Better Sweater" },
  { slug: "patagonia-jackets", label: "Patagonia Jackets", brand: "Patagonia", categoryId: "57988", q: "jacket" },
  { slug: "carhartt-jackets", label: "Carhartt Jackets", brand: "Carhartt", categoryId: "57988", q: "jacket" },
  { slug: "levis-501-jeans", label: "Levi's 501 Jeans", brand: "Levi's", categoryId: "11450", q: "501" },
  { slug: "nike-vintage-tees", label: "Nike Vintage Tees", brand: "Nike", categoryId: "15687", q: "vintage tee" },
  { slug: "the-north-face-fleece", label: "The North Face Fleece", brand: "The North Face", categoryId: "11450", q: "fleece" },
  { slug: "lululemon-leggings", label: "Lululemon Leggings", brand: "Lululemon", categoryId: "11450", q: "align leggings" },
  { slug: "ralph-lauren-polo", label: "Ralph Lauren Polo Shirts", brand: "Ralph Lauren", categoryId: "11450", q: "polo" },
];

interface IndexSeedRow {
  slug: string;
  label: string;
  brand: string;
  category_id: string;
  q: string | null;
}

/**
 * The live curated catalog (US-845). Reads enabled seeds from
 * condition_index_seeds, ordered by priority. Falls back to CURATED_INDEX when
 * the table is empty or unreachable so the Index never goes dark.
 */
export async function getIndexSeeds(): Promise<IndexSeed[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("condition_index_seeds")
      .select("slug, label, brand, category_id, q")
      .eq("enabled", true)
      .order("priority", { ascending: true })
      .order("label", { ascending: true });
    if (error) throw error;
    const rows = (data ?? []) as IndexSeedRow[];
    if (rows.length === 0) return CURATED_INDEX;
    return rows.map((r) => ({
      slug: r.slug,
      label: r.label,
      brand: r.brand,
      categoryId: r.category_id,
      q: r.q ?? undefined,
    }));
  } catch (err) {
    captureException(err, { level: "warn", route: "condition-index.seeds" });
    return CURATED_INDEX;
  }
}

// A curve needs at least this much total comp support to be PUBLISHED (US-622).
// Exported so the admin curation surface (US-846) can flag entries that fall
// below the publish threshold for pruning.
export const MIN_INDEX_TOTAL_SAMPLE = 8;

export interface IndexCurveDto {
  slug: string;
  label: string;
  brand: string;
  categoryId: string;
  currency: string;
  // Only sufficient points are returned; insufficient grades are dropped so the
  // public chart never shows a fabricated number.
  points: Array<Pick<CurvePoint, "grade" | "lowCents" | "medianCents" | "highCents" | "sampleSize">>;
  totalSampleSize: number;
  refreshedAt: string;
}

export interface IndexHubItem {
  slug: string;
  label: string;
  brand: string;
  currency: string;
  headlineMedianCents: number | null; // value at a grade-8 ("Excellent") anchor
  totalSampleSize: number;
  refreshedAt: string;
}

interface CurveRow {
  slug: string;
  label: string | null;
  brand: string | null;
  category_id: string;
  currency: string;
  curve: CurvePoint[];
  total_sample_size: number;
  refreshed_at: string;
}

function toDto(row: CurveRow): IndexCurveDto {
  return {
    slug: row.slug,
    label: row.label ?? row.brand ?? row.slug,
    brand: row.brand ?? "",
    categoryId: row.category_id,
    currency: row.currency,
    // US-622: publish only points with real comp support.
    points: (row.curve ?? [])
      .filter((p) => p.sufficient && p.medianCents != null)
      .map((p) => ({
        grade: p.grade,
        lowCents: p.lowCents,
        medianCents: p.medianCents,
        highCents: p.highCents,
        sampleSize: p.sampleSize,
      })),
    totalSampleSize: row.total_sample_size,
    refreshedAt: row.refreshed_at,
  };
}

const HUB_SELECT =
  "slug, label, brand, category_id, currency, curve, total_sample_size, refreshed_at";

/** Hub list: every published (sufficient) curated curve. */
export async function getIndexHub(): Promise<IndexHubItem[]> {
  const { data } = await supabaseAdmin
    .from("condition_price_curves")
    .select(HUB_SELECT)
    .not("slug", "is", null)
    .gte("total_sample_size", MIN_INDEX_TOTAL_SAMPLE)
    .order("total_sample_size", { ascending: false });

  return ((data ?? []) as CurveRow[]).map((row) => {
    const dto = toDto(row);
    const g8 = dto.points.find((p) => p.grade === 8) ?? dto.points.find((p) => p.medianCents != null);
    return {
      slug: dto.slug,
      label: dto.label,
      brand: dto.brand,
      currency: dto.currency,
      headlineMedianCents: g8?.medianCents ?? null,
      totalSampleSize: dto.totalSampleSize,
      refreshedAt: dto.refreshedAt,
    };
  });
}

/** One curve by slug, or null if absent / suppressed for thin data (US-622). */
export async function getIndexCurveBySlug(slug: string): Promise<IndexCurveDto | null> {
  const { data } = await supabaseAdmin
    .from("condition_price_curves")
    .select(HUB_SELECT)
    .eq("slug", slug)
    .maybeSingle();
  if (!data) return null;
  const row = data as CurveRow;
  if (row.total_sample_size < MIN_INDEX_TOTAL_SAMPLE) return null;
  const dto = toDto(row);
  if (dto.points.length === 0) return null;
  return dto;
}

/**
 * Rebuild ONE curve from fresh comps and persist it. Returns true on success.
 * Shared by the cron (refreshConditionIndex) and the admin on-demand refresh
 * (US-846) so the build+persist logic lives in exactly one place.
 */
export async function refreshIndexSeed(seed: IndexSeed): Promise<boolean> {
  try {
    const curve = await buildValueCurve({ categoryId: seed.categoryId, brand: seed.brand, q: seed.q });
    const itemKey = normalizeItemKey({ categoryId: seed.categoryId, brand: seed.brand, q: seed.q });
    const { error } = await supabaseAdmin
      .from("condition_price_curves")
      .upsert(
        {
          item_key: itemKey,
          slug: seed.slug,
          label: seed.label,
          brand: seed.brand,
          category_id: seed.categoryId,
          query: seed.q ?? null,
          currency: curve.currency,
          curve: curve.points,
          total_sample_size: curve.totalSampleSize,
          refreshed_at: curve.refreshedAt,
        },
        { onConflict: "item_key" },
      );
    if (error) {
      logEvent("warn", "condition-index.persist_failed", { slug: seed.slug });
      return false;
    }
    return true;
  } catch (err) {
    captureException(err, { level: "warn", route: "condition-index.refresh", tags: { slug: seed.slug } });
    return false;
  }
}

// Cron: rebuild every curated curve from fresh comps and stamp its slug/label.
export async function refreshConditionIndex(): Promise<{ refreshed: number; failed: number }> {
  let refreshed = 0;
  let failed = 0;
  const seeds = await getIndexSeeds();
  for (const seed of seeds) {
    if (await refreshIndexSeed(seed)) refreshed += 1;
    else failed += 1;
  }
  logEvent("info", "condition-index.refresh", { refreshed, failed });
  return { refreshed, failed };
}

export async function handleConditionIndexRefreshCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("condition-index-refresh", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await refreshConditionIndex();
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "condition-index.cron" });
    return c.json({ error: "Condition Index refresh failed" }, 500);
  } finally {
    await lock.release();
  }
}
