// US-2425: the number that makes specifics work measurable.
//
// Two halves: buildAspectCoverage scores ONE draft against its category spec
// (ai-listing.ts), and summarizeCoverage rolls many drafts up for the operator
// console (routes/admin-listing-coverage.ts). Both pure — no AI, no Supabase —
// but ai-listing.ts imports the service-role client at load, so set dummy env
// BEFORE the dynamic import.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildAspectCoverage, rankedAspectSpecs } = await import("../lib/ai-listing.ts");
const {
  DEFAULT_COVERAGE_WINDOW,
  MAX_COVERAGE_WINDOW,
  MIN_DRAFTS_PER_CATEGORY,
  median,
  parseWindow,
  summarizeCoverage,
} = await import("../routes/admin-listing-coverage.ts");
type CoverageRow = import("../routes/admin-listing-coverage.ts").CoverageRow;
type RankedAspectSpec = import("../lib/aspect-provenance.ts").RankedAspectSpec;

const AT = "2026-08-07T12:00:00.000Z";

const aspect = (
  name: string,
  usage: "REQUIRED" | "RECOMMENDED" | "OPTIONAL",
  searchCount?: number,
): RankedAspectSpec => ({
  localizedAspectName: name,
  aspectConstraint: { aspectRequired: usage === "REQUIRED", aspectUsage: usage },
  ...(searchCount === undefined ? {} : { relevanceIndicator: { searchCount } }),
});

// ── buildAspectCoverage: one draft ──────────────────────────────────────────

Deno.test("US-2425: required and recommended are scored SEPARATELY", () => {
  const specs = [
    aspect("Brand", "REQUIRED"),
    aspect("Size", "REQUIRED"),
    aspect("Department", "REQUIRED"),
    aspect("Pattern", "RECOMMENDED", 900),
    aspect("Fit", "RECOMMENDED", 4000),
    aspect("Season", "RECOMMENDED", 10),
    aspect("Custom Bundle", "OPTIONAL"),
  ];
  const cov = buildAspectCoverage(
    specs,
    { Brand: ["Nike"], Size: ["M"], Pattern: ["Striped"] },
    "57988",
    AT,
  );
  assertEquals(cov.categoryId, "57988");
  assertEquals(cov.required, {
    filled: 2,
    total: 3,
    missing: ["Department"],
  });
  // Recommended missing is ranked by eBay's own 30-day search volume, so the
  // first name is the one buyers actually filter on.
  assertEquals(cov.recommended, { filled: 1, total: 3, missing: ["Fit", "Season"] });
  assertEquals(cov.computedAt, AT);
  // OPTIONAL aspects count toward neither tier.
});

Deno.test("US-2425: a blank value does not count as filled", () => {
  const cov = buildAspectCoverage(
    [aspect("Brand", "REQUIRED"), aspect("Fit", "RECOMMENDED")],
    { Brand: [], Fit: ["   "] },
    "1",
    AT,
  );
  assertEquals(cov.required.filled, 0);
  assertEquals(cov.recommended.filled, 0);
});

Deno.test("US-2425: a fully covered draft reports no gaps in either tier", () => {
  const cov = buildAspectCoverage(
    [aspect("Brand", "REQUIRED"), aspect("Fit", "RECOMMENDED")],
    { Brand: ["Nike"], Fit: ["Slim"] },
    "1",
    AT,
  );
  assertEquals(cov.required, { filled: 1, total: 1, missing: [] });
  assertEquals(cov.recommended, { filled: 1, total: 1, missing: [] });
});

Deno.test("US-2425: rankedAspectSpecs digs the list out of eBay's nesting, safely", () => {
  assertEquals(
    rankedAspectSpecs({ aspects: { aspects: [aspect("Brand", "REQUIRED")] } }).length,
    1,
  );
  assertEquals(rankedAspectSpecs(null), []);
  assertEquals(rankedAspectSpecs({}), []);
  assertEquals(rankedAspectSpecs({ aspects: { aspects: "nope" } }), []);
});

// ── summarizeCoverage: the operator roll-up ─────────────────────────────────

const row = (
  categoryId: string,
  reqFilled: number,
  reqTotal: number,
  recFilled: number,
  recTotal: number,
  reqMissing: string[] = [],
  recMissing: string[] = [],
): CoverageRow => ({
  platform_category_id: categoryId,
  aspect_coverage: {
    categoryId,
    required: { filled: reqFilled, total: reqTotal, missing: reqMissing },
    recommended: { filled: recFilled, total: recTotal, missing: recMissing },
  },
});

Deno.test("US-2425: median is a median, not a mean", () => {
  assertEquals(median([0.1, 0.9, 0.5]), 0.5);
  assertEquals(median([0.2, 0.4]), 0.3);
  // An outlier moves a mean and barely moves this.
  assertEquals(median([0.5, 0.5, 0.5, 0.5, 0]), 0.5);
  assertEquals(median([]), null);
});

Deno.test("US-2425: coverage is broken out per leaf so one weak vertical is visible", () => {
  const rows: CoverageRow[] = [
    // Shoes: healthy.
    ...[0, 1, 2].map(() => row("shoes", 4, 4, 8, 10)),
    // Bags: the regression — half the recommended aspects unfilled.
    ...[0, 1, 2].map(() => row("bags", 2, 4, 2, 10, ["Style", "Size"], ["Lining", "Closure"])),
  ];
  const report = summarizeCoverage(rows, 200);
  assertEquals(report.drafts, 6);
  assertEquals(report.byCategory.length, 2);
  // Worst first — the point of the page is finding the weak vertical.
  assertEquals(report.byCategory[0].categoryId, "bags");
  assertEquals(report.byCategory[0].medianRecommended, 0.2);
  assertEquals(report.byCategory[0].medianRequired, 0.5);
  assertEquals(report.byCategory[1].categoryId, "shoes");
  assertEquals(report.byCategory[1].medianRecommended, 0.8);
  // Every bags draft has a required gap, so none of them can publish as-is.
  assertEquals(report.byCategory[0].draftsBlocked, 3);
  assertEquals(report.byCategory[1].draftsBlocked, 0);
  assertEquals(report.draftsBlocked, 3);
  assertEquals(report.medianRecommended, 0.5); // (0.2,0.2,0.2,0.8,0.8,0.8)
});

Deno.test("US-2425: the most-missed recommended aspects surface per leaf", () => {
  const rows: CoverageRow[] = [
    row("bags", 1, 1, 0, 3, [], ["Lining", "Closure", "Style"]),
    row("bags", 1, 1, 0, 3, [], ["Lining", "Closure"]),
    row("bags", 1, 1, 0, 3, [], ["Lining"]),
  ];
  assertEquals(summarizeCoverage(rows, 200).byCategory[0].topMissing, [
    { name: "Lining", drafts: 3 },
    { name: "Closure", drafts: 2 },
    { name: "Style", drafts: 1 },
  ]);
});

Deno.test("US-2425: a leaf with too few drafts is left out of the breakdown, not the totals", () => {
  const rows: CoverageRow[] = [
    ...[0, 1, 2].map(() => row("shoes", 1, 1, 5, 10)),
    row("bags", 1, 1, 0, 10), // one draft — a median of one is not a measurement
  ];
  const report = summarizeCoverage(rows, 200);
  assertEquals(report.byCategory.map((c) => c.categoryId), ["shoes"]);
  assertEquals(report.drafts, 4); // still counted overall
  assertEquals(MIN_DRAFTS_PER_CATEGORY, 3);
});

Deno.test("US-2425: a tier with no aspects is unmeasurable, not zero", () => {
  const rows: CoverageRow[] = [0, 1, 2].map(() => ({
    platform_category_id: "x",
    aspect_coverage: {
      categoryId: "x",
      required: { filled: 0, total: 0, missing: [] },
      recommended: { filled: 0, total: 0, missing: [] },
    },
  }));
  const report = summarizeCoverage(rows, 200);
  assertEquals(report.medianRecommended, null);
  assertEquals(report.medianRequired, null);
  assertEquals(report.byCategory[0].medianRecommended, null);
});

Deno.test("US-2425: malformed and empty inputs summarize to an empty report", () => {
  assertEquals(summarizeCoverage([], 200), {
    window: 200,
    drafts: 0,
    medianRecommended: null,
    medianRequired: null,
    draftsBlocked: 0,
    byCategory: [],
  });
  const report = summarizeCoverage(
    [{ platform_category_id: "a", aspect_coverage: null }],
    200,
  );
  assertEquals(report.drafts, 0);
});

Deno.test("US-2425: the window is clamped so the aggregate can't be asked for the world", () => {
  assertEquals(parseWindow(undefined), DEFAULT_COVERAGE_WINDOW);
  assertEquals(parseWindow(""), DEFAULT_COVERAGE_WINDOW);
  assertEquals(parseWindow("abc"), DEFAULT_COVERAGE_WINDOW);
  assertEquals(parseWindow("0"), DEFAULT_COVERAGE_WINDOW);
  assertEquals(parseWindow("-5"), DEFAULT_COVERAGE_WINDOW);
  assertEquals(parseWindow("50"), 50);
  assertEquals(parseWindow("999999"), MAX_COVERAGE_WINDOW);
});
