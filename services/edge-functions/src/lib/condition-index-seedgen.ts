// Value/Condition Index auto-seed generation (US-1746).
//
// The Index started with ~54 hand-curated seeds (CURATED_INDEX). This proposes
// NEW seeds from real demand so the Index scales without producing thin pages:
//   1. Demand signal — the (brand, garment_type) pairs GradeThread actually
//      GRADES, ranked by grade count. This is the most direct, privacy-safe
//      "what do people care about" signal we have. (The other sources the story
//      floated are unsuitable: keyword_research_terms holds our own MARKETING
//      keywords, not garment demand; repricing comps are tenant-private
//      inventory, which we don't cross-tenant aggregate. Documented, not used.)
//   2. Trial comp fetch — a candidate becomes an ENABLED seed only when a live
//      buildValueCurve clears MIN_INDEX_TOTAL_SAMPLE, so no thin page is ever
//      published (same bar as the curated refresh).
//   3. Guardrails — idempotent + deduped on the seed slug, bounded by a per-run
//      candidate budget (each trial = several eBay Browse calls), behind a
//      kill-switch. Config via system_settings `condition_index_seedgen`.

import { supabaseAdmin } from "./supabase.ts";
import { buildValueCurve, normalizeItemKey } from "./condition-curve.ts";
import { suggestCategories } from "./ebay-client.ts";
import { MIN_INDEX_TOTAL_SAMPLE, persistSeededCurve } from "./condition-index.ts";
import { slugify } from "./value-index.ts";
import { getSetting } from "./system-settings.ts";
import { captureException, logEvent } from "./observability.ts";
import { requireJobSecret } from "./job-auth.ts";
import { acquireJobLock } from "./job-lock.ts";

export interface SeedGenConfig {
  /** Kill-switch — false proposes nothing. OFF by default (operator opt-in). */
  enabled: boolean;
  /** Per-run candidate budget (each candidate trial = several eBay Browse calls). */
  maxCandidatesPerRun: number;
  /** A (brand, garment_type) pair needs at least this many grades to be a candidate. */
  minGradedCount: number;
  /** How many recent graded submissions to scan for demand. */
  scanLimit: number;
}

export const DEFAULT_SEEDGEN_CONFIG: SeedGenConfig = {
  enabled: false,
  maxCandidatesPerRun: 5,
  minGradedCount: 3,
  scanLimit: 4000,
};

export interface SeedCandidate {
  brand: string;
  /** Garment type used as the comp keyword, e.g. "jacket". */
  keyword: string;
  /** Grade count — the demand ranking signal. */
  demand: number;
}

/** Public URL slug for a candidate — matches the curated `${brand}-${item}` shape. Pure. */
export function candidateSlug(brand: string, keyword: string): string {
  return slugify(`${brand}-${keyword}`);
}

/** Human label for a candidate, e.g. "Patagonia Jacket". Pure. */
export function candidateLabel(brand: string, keyword: string): string {
  const kw = keyword
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return `${brand.trim()} ${kw}`.trim();
}

/**
 * Drop candidates that already have a seed (by slug) and de-dupe among
 * themselves, then rank highest-demand first. PURE so the dedup + ranking is
 * unit-tested without the DB.
 */
export function dedupeCandidates(
  candidates: SeedCandidate[],
  existingSlugs: Set<string>,
): SeedCandidate[] {
  const seen = new Set(existingSlugs);
  const out: SeedCandidate[] = [];
  for (const c of candidates) {
    const slug = candidateSlug(c.brand, c.keyword);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(c);
  }
  out.sort((a, b) => b.demand - a.demand);
  return out;
}

/** Distinct (brand, garment_type) pairs among graded submissions, by grade count. */
async function gatherGradedPairs(config: SeedGenConfig): Promise<SeedCandidate[]> {
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select("brand, garment_type")
    .eq("status", "completed")
    .not("brand", "is", null)
    .not("garment_type", "is", null)
    .limit(config.scanLimit);
  if (error) throw error;

  const counts = new Map<string, SeedCandidate>();
  for (const row of (data ?? []) as Array<{ brand: string | null; garment_type: string | null }>) {
    const brand = (row.brand ?? "").trim();
    const keyword = (row.garment_type ?? "").trim();
    if (!brand || !keyword) continue;
    const key = `${brand.toLowerCase()}|${keyword.toLowerCase()}`;
    const existing = counts.get(key);
    if (existing) existing.demand += 1;
    else counts.set(key, { brand, keyword, demand: 1 });
  }
  return [...counts.values()].filter((c) => c.demand >= config.minGradedCount);
}

/** Load the slugs of every existing seed so generation never duplicates one. */
async function loadExistingSlugs(): Promise<Set<string>> {
  const { data } = await supabaseAdmin.from("condition_index_seeds").select("slug");
  return new Set(((data ?? []) as Array<{ slug: string }>).map((r) => r.slug));
}

export interface SeedGenResult {
  inserted: number;
  /** Candidates trialed but too thin to publish (logged, not inserted). */
  insufficient: number;
  /** Candidates skipped for a category-resolution / fetch error. */
  errored: number;
  /**
   * US-2847: candidates whose cell has already been MEASURED from real comp
   * reads, so the generated curve was not written. Counted separately from
   * `errored` because it is the guard working, not a failure.
   */
  skippedMeasured: number;
  /** Total fresh candidates (before the budget cap). */
  candidates: number;
  /** True when more candidates were available than the budget allowed. */
  budgetCapped: boolean;
  disabled?: boolean;
}

/**
 * Propose + insert new Index seeds from graded-demand. Idempotent (deduped on
 * slug), budget-bounded, kill-switched. Only inserts a seed whose trial curve
 * has real comp depth, and persists that trial curve so the page is live at once.
 */
export async function generateSeeds(now = new Date()): Promise<SeedGenResult> {
  const config = await getSetting<SeedGenConfig>("condition_index_seedgen", DEFAULT_SEEDGEN_CONFIG);
  if (!config.enabled) {
    logEvent("info", "condition-index.seedgen.disabled", {});
    return {
      inserted: 0,
      insufficient: 0,
      errored: 0,
      skippedMeasured: 0,
      candidates: 0,
      budgetCapped: false,
      disabled: true,
    };
  }

  const [pairs, existingSlugs] = await Promise.all([gatherGradedPairs(config), loadExistingSlugs()]);
  const fresh = dedupeCandidates(pairs, existingSlugs);
  const budget = Math.max(0, Math.trunc(config.maxCandidatesPerRun));
  const batch = fresh.slice(0, budget);

  let inserted = 0;
  let insufficient = 0;
  let errored = 0;
  let skippedMeasured = 0;
  for (const c of batch) {
    try {
      const cats = await suggestCategories(`${c.brand} ${c.keyword}`.trim());
      const categoryId = cats[0]?.categoryId;
      if (!categoryId) {
        errored += 1;
        continue;
      }
      const curve = await buildValueCurve({ categoryId, brand: c.brand, q: c.keyword });
      if (curve.totalSampleSize < MIN_INDEX_TOTAL_SAMPLE) {
        insufficient += 1;
        logEvent("info", "condition-index.seedgen.insufficient", {
          slug: candidateSlug(c.brand, c.keyword),
          sample: curve.totalSampleSize,
        });
        continue;
      }

      const slug = candidateSlug(c.brand, c.keyword);
      const itemKey = normalizeItemKey({ categoryId, brand: c.brand, q: c.keyword });
      // Insert the seed (idempotent on slug) + persist the trial curve so the page
      // is live immediately without a second comp fetch.
      const { error: seedErr } = await supabaseAdmin.from("condition_index_seeds").upsert(
        {
          slug,
          label: candidateLabel(c.brand, c.keyword),
          brand: c.brand,
          category_id: categoryId,
          q: c.keyword,
          enabled: true,
          source: "generated",
          generated_at: now.toISOString(),
        },
        { onConflict: "slug", ignoreDuplicates: true },
      );
      if (seedErr) {
        errored += 1;
        continue;
      }
      // US-2847: seeded writes go through persistSeededCurve, which refuses to
      // overwrite a cell that has been measured from real comp reads. A raw
      // upsert here would silently replace measured points with generated ones
      // on the next seedgen run.
      const persisted = await persistSeededCurve({
        item_key: itemKey,
        slug,
        label: candidateLabel(c.brand, c.keyword),
        brand: c.brand,
        category_id: categoryId,
        query: c.keyword,
        currency: curve.currency,
        curve: curve.points,
        total_sample_size: curve.totalSampleSize,
        refreshed_at: curve.refreshedAt,
      });
      if (persisted.skipped) {
        skippedMeasured += 1;
        logEvent("info", "condition-index.seedgen.skipped_measured", { slug });
        continue;
      }
      inserted += 1;
    } catch (err) {
      errored += 1;
      captureException(err, {
        level: "warn",
        route: "condition-index.seedgen",
        tags: { slug: candidateSlug(c.brand, c.keyword) },
      });
    }
  }

  logEvent("info", "condition-index.seedgen", {
    inserted,
    insufficient,
    errored,
    skippedMeasured,
    candidates: fresh.length,
    budget,
    budgetCapped: fresh.length > batch.length,
  });
  return {
    inserted,
    insufficient,
    errored,
    skippedMeasured,
    candidates: fresh.length,
    budgetCapped: fresh.length > batch.length,
  };
}

// Cron entry: job-secret gated + single-flight locked (mirrors the refresh cron).
export async function handleConditionIndexSeedGenCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("condition-index-seedgen", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await generateSeeds();
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "condition-index.seedgen.cron" });
    return c.json({ error: "Seed generation failed" }, 500);
  } finally {
    await lock.release();
  }
}
