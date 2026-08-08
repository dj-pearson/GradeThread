// US-2425: the operator view of how complete AutoLister's generated drafts are.
//
// Mounted at /api/admin/listing-coverage — the /api/admin/* middleware (auth +
// adminAuthMiddleware) already gates it, so a seller can never reach it. This
// is deliberately CROSS-TENANT: the question it answers ("is the specifics
// pipeline getting better or worse, and in which vertical?") is meaningless
// inside one seller's data. Nothing identifying is returned — no listing ids,
// no item ids, no user ids — only per-category aggregates.
//
// Median, not mean: a handful of drafts on an obscure leaf with two aspects
// would otherwise drag the whole number around. The median is what "a typical
// draft" actually looks like.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { requireScope } from "../lib/scope-guard.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminListingCoverageRoutes = new Hono<AdminEnv>();

// Read-only console, but the scope set has no marketplace:read — the listing
// pipeline lives under marketplace:write, so that is the gate.
adminListingCoverageRoutes.use("*", requireScope("marketplace:write"));

/** How many recent scored drafts the window covers by default, and at most. */
export const DEFAULT_COVERAGE_WINDOW = 200;
export const MAX_COVERAGE_WINDOW = 1000;

/** Categories with fewer drafts than this are left OUT of the per-category
 *  breakdown — a median over one or two drafts is noise dressed up as a
 *  measurement. They still count toward the overall figures. */
export const MIN_DRAFTS_PER_CATEGORY = 3;

interface CoverageTier {
  filled?: number;
  total?: number;
  missing?: string[];
}

export interface StoredCoverage {
  categoryId?: string | null;
  required?: CoverageTier;
  recommended?: CoverageTier;
}

export interface CoverageRow {
  platform_category_id: string | null;
  aspect_coverage: StoredCoverage | null;
}

export interface CategoryCoverageSummary {
  categoryId: string;
  drafts: number;
  /** Median share of RECOMMENDED aspects filled, 0..1 (null when the leaf has
   *  no recommended aspects at all). */
  medianRecommended: number | null;
  /** Median share of REQUIRED aspects filled, 0..1. */
  medianRequired: number | null;
  /** Drafts in this leaf with at least one unfilled REQUIRED aspect — these
   *  cannot publish as they stand. */
  draftsBlocked: number;
  /** The recommended aspects most often missing here, most-missed first. */
  topMissing: Array<{ name: string; drafts: number }>;
}

export interface CoverageReport {
  window: number;
  drafts: number;
  medianRecommended: number | null;
  medianRequired: number | null;
  draftsBlocked: number;
  byCategory: CategoryCoverageSummary[];
}

/** Median of a numeric list. Even counts average the two middle values.
 *  Returns null for an empty list rather than inventing a zero. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const m = sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
  // Two decimals is all the resolution a coverage share deserves.
  return Math.round(m * 100) / 100;
}

/** filled/total as a 0..1 share, or null when the tier has no aspects (a leaf
 *  with zero recommended aspects is not 0% covered — it is not measurable). */
function share(tier: CoverageTier | undefined): number | null {
  const total = Number(tier?.total);
  if (!Number.isFinite(total) || total <= 0) return null;
  const filled = Number(tier?.filled);
  if (!Number.isFinite(filled)) return null;
  return Math.min(1, Math.max(0, filled / total));
}

/**
 * Roll the stored per-draft coverage up into the operator report. PURE, so the
 * aggregation is testable without a database — and so a regression in one
 * vertical is a test failure rather than a chart someone has to squint at.
 */
export function summarizeCoverage(
  rows: CoverageRow[],
  window: number,
): CoverageReport {
  const overallRecommended: number[] = [];
  const overallRequired: number[] = [];
  let overallBlocked = 0;

  interface Bucket {
    recommended: number[];
    required: number[];
    blocked: number;
    missing: Map<string, number>;
    drafts: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const cov = row.aspect_coverage;
    if (!cov) continue;
    const categoryId = (cov.categoryId ?? row.platform_category_id ?? "").trim() ||
      "unknown";
    let bucket = buckets.get(categoryId);
    if (!bucket) {
      bucket = { recommended: [], required: [], blocked: 0, missing: new Map(), drafts: 0 };
      buckets.set(categoryId, bucket);
    }
    bucket.drafts++;

    const rec = share(cov.recommended);
    if (rec !== null) {
      bucket.recommended.push(rec);
      overallRecommended.push(rec);
    }
    const reqShare = share(cov.required);
    if (reqShare !== null) {
      bucket.required.push(reqShare);
      overallRequired.push(reqShare);
    }
    if ((cov.required?.missing?.length ?? 0) > 0) {
      bucket.blocked++;
      overallBlocked++;
    }
    for (const name of cov.recommended?.missing ?? []) {
      if (!name) continue;
      bucket.missing.set(name, (bucket.missing.get(name) ?? 0) + 1);
    }
  }

  const byCategory: CategoryCoverageSummary[] = [];
  for (const [categoryId, b] of buckets) {
    if (b.drafts < MIN_DRAFTS_PER_CATEGORY) continue;
    byCategory.push({
      categoryId,
      drafts: b.drafts,
      medianRecommended: median(b.recommended),
      medianRequired: median(b.required),
      draftsBlocked: b.blocked,
      topMissing: [...b.missing.entries()]
        .map(([name, drafts]) => ({ name, drafts }))
        .sort((a, b2) => b2.drafts - a.drafts || a.name.localeCompare(b2.name))
        .slice(0, 8),
    });
  }
  // Worst coverage first — the point of the page is finding the weak vertical.
  byCategory.sort(
    (a, b) =>
      (a.medianRecommended ?? 1) - (b.medianRecommended ?? 1) ||
      b.drafts - a.drafts ||
      a.categoryId.localeCompare(b.categoryId),
  );

  return {
    window,
    drafts: rows.filter((r) => r.aspect_coverage).length,
    medianRecommended: median(overallRecommended),
    medianRequired: median(overallRequired),
    draftsBlocked: overallBlocked,
    byCategory,
  };
}

/** Clamp the ?limit= window to something the aggregate can chew through. */
export function parseWindow(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COVERAGE_WINDOW;
  return Math.min(MAX_COVERAGE_WINDOW, Math.floor(n));
}

// ── GET / ─────────────────────────────────────────────────────────
// Median eBay-aspect coverage over the last N generated drafts, broken out by
// leaf category so a regression in one vertical is visible.
adminListingCoverageRoutes.get("/", async (c) => {
  const window = parseWindow(c.req.query("limit"));
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("platform_category_id, aspect_coverage")
    .not("aspect_coverage", "is", null)
    .order("updated_at", { ascending: false })
    .limit(window);
  if (error) return jsonError(c, 500, "Failed to load draft coverage");
  return c.json(summarizeCoverage((data ?? []) as CoverageRow[], window));
});
