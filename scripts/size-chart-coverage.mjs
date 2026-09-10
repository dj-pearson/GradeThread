// US-3283: which brands have a size chart for which garment, and which do not.
//
// WHY THIS ISN'T A GREP. The corpus has 289 brand-specific charts across 167
// brands (run the script for today's count), and the
// obvious way to count coverage — "how many charts does this brand have?" — is
// the wrong question. What the size-guide panel needs to know is whether a
// chart RESOLVES for a real query: brand + garment + department, matched the
// way flipdesk-size-bands.ts matches it. A brand can hold two charts and still
// show an empty panel for jeans, because both of its charts are tops.
//
// So this script asks the resolver, not the data. For every brand it runs one
// representative garment query per measurement group through the same
// findSizingCharts + categoryMatch filter the route uses, and reports what a
// seller would actually see.
//
// A Deno script, not Node, for the reason gen-sizing-chart-seed.mjs is: the
// corpus lives in the edge service's TypeScript and is imported directly rather
// than re-parsed. Re-parsing is how a coverage report starts lying.
//
// Usage:
//   deno run --allow-read --allow-write scripts/size-chart-coverage.mjs
//   deno run --allow-read scripts/size-chart-coverage.mjs --json
//   deno run --allow-read scripts/size-chart-coverage.mjs --gaps --limit 10
//   deno run --allow-read scripts/size-chart-coverage.mjs --gaps --all
//
// `--gaps` is the backfill loop's input: the brands with the most missing
// groups, worst first, as a plain list to work through.

import { SIZING_CHARTS, findSizingCharts } from "../services/edge-functions/src/lib/sizing-charts.ts";

const OUT = new URL("../docs/size-chart-coverage.md", import.meta.url);

/**
 * One representative query per measurement group.
 *
 * These are the words a seller's category actually contains, not the group
 * names — `categoryMatch` holds garment words ("tee", "jean", "sneaker"), so
 * querying "top" or "shoes" would under-report every chart that spells its
 * keywords out. Each entry lists several because a brand may cover jeans and
 * not shorts, and a group counts as covered when ANY of its words resolve.
 */
const GROUP_QUERIES = {
  top: ["tee", "shirt", "hoodie", "sweater"],
  bottom: ["jeans", "pants", "shorts", "leggings"],
  dress: ["dress", "romper"],
  outerwear: ["jacket", "coat", "parka"],
  suit: ["suit", "blazer"],
  shoes: ["sneakers", "boots", "shoes"],
  bag: ["bag", "backpack", "tote"],
  watch: ["watch"],
  headwear: ["hat", "cap", "beanie"],
  accessory: ["belt", "scarf", "socks"],
};

const GROUPS = Object.keys(GROUP_QUERIES);

/**
 * Brands whose gap has been WORKED and cannot be closed from the brand itself.
 *
 * `--gaps` skips these, and that skip is the point: without it the loop re-offers
 * the same dead ends at the top of every batch, because "worst gap first" ranks
 * a brand by what is missing and a brand with no publishable chart is missing
 * the most. Batch 2 lost turns to exactly that.
 *
 * The bar for an entry is a reason a reader can check, not a shrug — and the
 * brand still appears in the report's table with its gap visible, so nothing is
 * hidden. Re-check these when a batch runs dry: a brand that took its guide down
 * can put one back.
 */
const WORKED_DEAD_ENDS = {
  "FRAME":
    "frame-store.com's own Denim Fit Guide page renders empty and its product pages carry no size link; every FRAME chart online belongs to a reseller (US-3284)",
  "Bonobos":
    "publishes a qualitative fit guide — body type and cut, no measurements (US-3285)",
  "Mackage": "its own /pages/size-chart renders with no table (US-3285)",
  "Barbour":
    "barbour.com/us/size-guide served the site's technical-difficulties page (US-3285)",
  "Hudson Jeans":
    "prints tops and jackets bust runs three inches apart without saying whether either is a body or a garment measurement (US-3285)",
  "Rag & Bone":
    "its size-chart page renders three of the run's rows and a corrupted conversion table, and its own how-to-measure describes measuring a GARMENT flat, so the basis is unstated (US-3286)",
  "PAIGE": "paige.com/size-guide renders no chart at all (US-3286)",
  "Moncler":
    "the size guide sits behind a panel that never emits a table; the 0-5 scale is published only as prose (US-3286)",
};

/**
 * The route's own narrowing, copied rather than imported: flipdesk-size-bands.ts
 * keeps `matchingCategory` private, and a coverage report that quietly diverged
 * from it would be worse than no report. If that function changes, this must.
 */
function matchingCategory(charts, garment) {
  const g = garment.toLowerCase().trim();
  if (!g) return [];
  return charts.filter((c) => c.categoryMatch.some((m) => g.includes(m)));
}

/** Charts this brand publishes itself, never the generic fallback. */
function brandCharts(brand) {
  return findSizingCharts(brand, null).filter((c) => c.brandMatch.length > 0);
}

/** Departments a group resolves for, e.g. ["Men", "Women"]. Empty means a gap. */
function departmentsCovered(charts, group) {
  const hit = new Set();
  for (const q of GROUP_QUERIES[group]) {
    for (const c of matchingCategory(charts, q)) hit.add(c.department);
  }
  return [...hit].sort();
}

function buildCoverage() {
  const brands = [
    ...new Set(SIZING_CHARTS.filter((c) => c.brandMatch.length > 0).map((c) => c.brand)),
  ].sort((a, b) => a.localeCompare(b));

  return brands.map((brand) => {
    const charts = brandCharts(brand);
    const groups = {};
    for (const g of GROUPS) groups[g] = departmentsCovered(charts, g);
    // What SHOULD this brand cover?
    //
    // Judging every brand against all ten groups would rank Rolex as the
    // biggest gap in the corpus and put "missing: dress" against Dickies —
    // which is how a priority list becomes noise nobody works through. Two
    // rules keep it honest:
    //
    //   1. A brand that sells apparel is expected to cover the apparel groups.
    //      One that sells only shoes or only watches is expected to cover only
    //      what it already sells.
    //   2. DRESSES ARE NOT A GAP, only a reported column.
    //
    // Rule 2 was learned the hard way in batch 1 (US-3284). The rule used to be
    // "dresses count for any brand that sells to women or unisex", and three of
    // that batch's ten brands came back still flagged: Canada Goose, Champion
    // and Denim Tears, none of which makes a dress. Three false gaps in ten is
    // enough to send whole later batches chasing charts that cannot exist, and
    // a brand that genuinely sells dresses is still visible — the dress column
    // is printed per brand either way. A gap you can see beats a gap that
    // schedules work.
    const apparel = ["top", "bottom", "outerwear"];
    const sellsApparel = apparel.some((g) => groups[g].length > 0) || groups.dress.length > 0;
    const expected = sellsApparel ? apparel : GROUPS.filter((g) => groups[g].length > 0);
    const missing = expected.filter((g) => groups[g].length === 0);
    return {
      brand,
      chartCount: charts.length,
      verified: charts.filter((c) => c.verified === true).length,
      withSourceUrl: charts.filter((c) => !!c.sourceUrl).length,
      groups,
      expected,
      missing,
    };
  });
}

function summarize(rows) {
  const perGroup = {};
  for (const g of GROUPS) perGroup[g] = rows.filter((r) => r.groups[g].length > 0).length;
  return {
    brands: rows.length,
    charts: SIZING_CHARTS.filter((c) => c.brandMatch.length > 0).length,
    verified: rows.reduce((n, r) => n + r.verified, 0),
    withSourceUrl: rows.reduce((n, r) => n + r.withSourceUrl, 0),
    brandsPerGroup: perGroup,
    brandsWithGaps: rows.filter((r) => r.missing.length > 0).length,
  };
}

function markdown(rows, sum) {
  const out = [];
  out.push("# Brand size-chart coverage");
  out.push("");
  out.push(
    "Generated by `deno run --allow-read --allow-write scripts/size-chart-coverage.mjs`. " +
      "Do not hand-edit; regenerate after adding charts.",
  );
  out.push("");
  out.push(
    "Coverage is measured the way the size-guide panel resolves a chart: a real " +
      "brand + garment query through `findSizingCharts`, narrowed by `categoryMatch`. " +
      "A brand can hold several charts and still show a gap here, which is the point.",
  );
  out.push("");
  out.push("## Where it stands");
  out.push("");
  out.push(`- ${sum.brands} brands, ${sum.charts} brand-specific charts.`);
  out.push(
    `- ${sum.withSourceUrl} charts link the brand's own guide; ${sum.verified} have been checked against it by a human.`,
  );
  out.push(`- ${sum.brandsWithGaps} brands are missing at least one group they should cover.`);
  out.push("");
  out.push("Worked dead ends, skipped by `--gaps` and still listed below:");
  out.push("");
  for (const [brand, why] of Object.entries(WORKED_DEAD_ENDS)) {
    out.push(`- **${brand}** — ${why}`);
  }
  out.push("");
  out.push("| Group | Brands covered |");
  out.push("|---|---:|");
  for (const g of GROUPS) out.push(`| ${g} | ${sum.brandsPerGroup[g]} |`);
  out.push("");
  out.push("## Per brand");
  out.push("");
  out.push(`| Brand | Charts | ${GROUPS.join(" | ")} | Missing |`);
  out.push(`|---|---:|${GROUPS.map(() => "---").join("|")}|---|`);
  for (const r of rows) {
    const cells = GROUPS.map((g) => (r.groups[g].length > 0 ? r.groups[g].join(", ") : ""));
    out.push(
      `| ${r.brand} | ${r.chartCount} | ${cells.join(" | ")} | ${r.missing.join(", ")} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

// ── Run ─────────────────────────────────────────────────────────────────────

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const args = Deno.args;
const rows = buildCoverage();
const sum = summarize(rows);

if (args.includes("--json")) {
  console.log(JSON.stringify({ summary: sum, brands: rows }, null, 2));
} else if (args.includes("--gaps")) {
  const limitAt = args.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 10;
  const withDeadEnds = args.includes("--all");
  const gaps = rows
    .filter((r) => r.missing.length > 0)
    .filter((r) => withDeadEnds || !WORKED_DEAD_ENDS[r.brand])
    // Worst first, then alphabetically so a rerun produces the same batch.
    .sort((a, b) => b.missing.length - a.missing.length || a.brand.localeCompare(b.brand))
    .slice(0, Number.isFinite(limit) ? limit : 10);
  for (const r of gaps) {
    console.log(
      r.brand + TAB + "missing: " + r.missing.join(", ") +
        TAB + "has: " + r.chartCount + " chart(s)",
    );
  }
  if (!withDeadEnds) {
    const n = Object.keys(WORKED_DEAD_ENDS).length;
    console.log(NL + "(" + n + " worked dead end(s) skipped; --all includes them)");
  }
} else {
  await Deno.writeTextFile(OUT, markdown(rows, sum));
  console.log(`[size-chart-coverage] wrote ${OUT.pathname.replace(/^\//, "")}`);
  console.log(
    `[size-chart-coverage] ${sum.brands} brands, ${sum.charts} charts, ` +
      `${sum.brandsWithGaps} with gaps, ${sum.verified} verified, ` +
      `${sum.withSourceUrl} linking the brand's own guide`,
  );
}
