// US-2917: serve the expected-size band table.
//
// GET /api/flipdesk/size-bands?brand=&garment=&gender=
//   → { tier, brandLabel, department, garment, sourceUrl, sizeSystem,
//       sizeClass, measurementBasis, rows }
//
// WHY A BAND TABLE AND NOT A VERDICT. US-2915 chose this shape over a
// per-keystroke "is this size wrong?" endpoint and over bundling the 292-chart
// corpus into every client. The edge does the judgement work ONCE — resolve the
// brand, pick the department, pick the garment group, apply the right ease — and
// hands back a small precomputed table. The composer then does a lookup on every
// keystroke with no network call, and iOS, Android and the web share one answer
// because they share one table.
//
// CHARTS RESOLVE DB-FIRST, through resolveBrandKnowledgePack against
// public.brand_size_charts, falling back to the in-code SIZING_CHARTS seed. Same
// pattern ai-size-estimate.ts uses, and for the same reason: an admin editing a
// chart in the brand-knowledge console changes what the composer shows with no
// deploy.
//
// US-268: this route takes NO item id and reads NO tenant table. brand_size_charts
// is a global reference table with deny-all RLS, read through the service-role
// client, and there is nothing here to scope by a user. An itemId param is
// REJECTED rather than ignored, so a future caller cannot quietly turn a
// reference lookup into a tenant read.

import { Hono } from "hono";
import { failSafe } from "../lib/http-errors.ts";
import { resolveBrandKnowledgePack } from "../lib/brand-knowledge.ts";
import { findSizingCharts, type SizingChart } from "../lib/sizing-charts.ts";
import { measurementGroupFor } from "../lib/measurement-templates.ts";
import {
  detectSizeClass,
  detectSizeSystem,
  normalizeDepartment,
} from "../lib/size-systems.ts";
import {
  buildSizeBands,
  type MeasurementBasis,
  type SizeBandRow,
  type SizeChartTier,
} from "../lib/size-check.ts";

export const flipdeskSizeBandsRoutes = new Hono<{
  Variables: { userId: string };
}>();

export interface SizeBandsResponse {
  tier: SizeChartTier;
  /** The chart's own brand name, or null when no chart matched. */
  brandLabel: string | null;
  department: string | null;
  /** The chart's garment scope, not the caller's query. */
  garment: string | null;
  sourceUrl: string | null;
  sizeSystem: string | null;
  sizeClass: string | null;
  measurementBasis: MeasurementBasis;
  rows: SizeBandRow[];
}

const EMPTY: SizeBandsResponse = {
  tier: "none",
  brandLabel: null,
  department: null,
  garment: null,
  sourceUrl: null,
  sizeSystem: null,
  sizeClass: null,
  measurementBasis: "body",
  rows: [],
};

/**
 * Charts whose category keywords actually match the garment.
 *
 * findSizingCharts and the pack assembler both fall back to the WHOLE pool when
 * a category narrows to nothing, which is right for the grading prompt — a
 * broad reference table costs the model nothing. It is wrong here. A generic
 * men's TOPS chart handed back for a wristwatch would put a 22 in chest band
 * behind an item that has no chest, and every false alarm this feature raises
 * is a step towards a seller switching it off.
 */
function matchingCategory(charts: SizingChart[], garment: string): SizingChart[] {
  const g = garment.toLowerCase().trim();
  if (!g) return [];
  return charts.filter((c) => c.categoryMatch.some((m) => g.includes(m)));
}

/** Charts for the department we can prove, or every chart when we cannot. */
function byDepartment(charts: SizingChart[], department: string | null): SizingChart[] {
  if (!department) return charts;
  const hit = charts.filter((c) => c.department === department);
  // A Unisex chart answers for either department; it is the brand's own answer
  // to the same question, not a guess we are making on its behalf.
  const unisex = charts.filter((c) => c.department === "Unisex");
  return hit.length > 0 ? hit : unisex;
}

function departmentsIn(charts: SizingChart[]): Set<string> {
  return new Set(charts.map((c) => c.department));
}

function tierFor(chart: SizingChart): SizeChartTier {
  if (chart.brandMatch.length === 0) return "generic";
  return chart.verified === true ? "verified" : "brand";
}

function respond(chart: SizingChart, garmentQuery: string): SizeBandsResponse {
  const basis: MeasurementBasis = chart.measurementBasis === "flat" ? "flat" : "body";
  const group = measurementGroupFor(garmentQuery || chart.garment);
  return {
    tier: tierFor(chart),
    brandLabel: chart.brand,
    department: chart.department,
    garment: chart.garment,
    sourceUrl: chart.sourceUrl ?? null,
    sizeSystem: chart.sizeSystem ?? detectSizeSystem(chart),
    sizeClass: chart.sizeClass ?? detectSizeClass(chart),
    measurementBasis: basis,
    rows: buildSizeBands(chart, group, basis),
  };
}

flipdeskSizeBandsRoutes.get("/", async (c) => {
  try {
    // US-268. The only ids this route could take are ids it has no business
    // reading, so it refuses them outright instead of silently dropping them.
    for (const forbidden of ["itemId", "item_id", "userId", "user_id"]) {
      if (c.req.query(forbidden) !== undefined) {
        return c.json(
          {
            error:
              "size-bands is a reference lookup and takes no item or user id — " +
              "pass brand, garment and gender only",
          },
          400,
        );
      }
    }

    const brand = (c.req.query("brand") ?? "").trim();
    const garment = (c.req.query("garment") ?? "").trim();
    const department = normalizeDepartment(c.req.query("gender"));

    // Identical params must produce an identical body, and a band table is good
    // for the whole time a seller spends editing one item.
    c.header("Cache-Control", "private, max-age=1800");

    if (!garment) return c.json(EMPTY);

    const genericPool = matchingCategory(findSizingCharts(null, garment), garment);

    let pool: SizingChart[] = [];
    if (brand) {
      const pack = await resolveBrandKnowledgePack(brand, { category: garment });
      // resolveBrandKnowledgePack falls back to the generic charts when a brand
      // has none of its own, so brand-specific charts have to be separated back
      // out — reporting a generic table as tier "brand" is the one thing this
      // response must never do.
      pool = matchingCategory(
        (pack?.sizingCharts ?? []).filter((ch) => ch.brandMatch.length > 0),
        garment,
      );
    }
    const isBrandPool = pool.length > 0;
    if (!isBrandPool) pool = genericPool;

    // A brand that sells to more than one department, and an item that does not
    // say which: guessing here would put a women's chart behind a men's tee.
    // Drop to the generic table instead, which is honest about being an estimate.
    if (isBrandPool && !department && departmentsIn(pool).size > 1) {
      pool = genericPool;
    }

    const narrowed = byDepartment(pool, department);
    // Still ambiguous after the department filter (no gender, and the generic
    // pool itself spans Men and Women) — say nothing rather than pick one.
    if (narrowed.length > 1 && !department && departmentsIn(narrowed).size > 1) {
      return c.json(EMPTY);
    }
    const chart = narrowed[0];
    if (!chart) return c.json(EMPTY);

    return c.json(respond(chart, garment));
  } catch (err) {
    return failSafe(c, 500, "Could not load size bands", err, "size-bands");
  }
});
