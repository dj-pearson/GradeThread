// US-2922: which brands actually need a size chart, and which of them have one.
//
// THE POINT IS THE RANKING, and it is the reason this is a script rather than a
// list somebody wrote down. "The top 100 brands" is a claim about the platform's
// real inventory, and intuition is wrong about it in both directions — the
// brands a founder thinks of are the ones with high prices, not the ones with
// high row counts. So the target list is derived from `inventory_items.brand`
// every time, and the coverage number is derived against the same list.
//
// It reports three things:
//   1. The top N brands by inventory_items.brand row count.
//   2. For each, which departments it actually sells (from the items, not from
//      a guess) and whether public.brand_size_charts holds a chart for each.
//   3. The headline: how many of the top N have a VERIFIED chart per department.
//
// A chart that exists but is unverified counts as coverage of the "brand" tier
// and NOT of the verified tier, because that is exactly the distinction the
// composer's tolerance rule turns on — one size step on a chart a human checked,
// two on anything else.
//
// READ-ONLY. It writes nothing, so it is safe against prod, which is where the
// only meaningful answer lives: a local stack has no inventory to rank.
//
//   deno run --allow-net --allow-env services/edge-functions/scripts/size-chart-coverage.ts [--top 100] [--json]
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import { brandKey } from "../src/lib/brand-normalize.ts";
import { normalizeDepartment } from "../src/lib/size-systems.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}

const args = Deno.args;
function flagValue(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const TOP = flagValue("--top", 100);
const AS_JSON = args.includes("--json");

const db = createClient(url, key, { auth: { persistSession: false } });

// ── 1. Rank brands by real row count ────────────────────────────────────────

interface ItemRow {
  brand: string | null;
  item_category: string | null;
  garment_category: string | null;
  title: string | null;
  size: string | null;
}

/**
 * Every item's brand and the few columns the department is read from.
 *
 * Paged rather than aggregated in SQL because PostgREST cannot GROUP BY, and an
 * RPC for this would be a migration for a reporting script. At platform scale
 * this is a few hundred thousand short rows; it takes seconds and it is a read.
 */
async function readItems(): Promise<ItemRow[]> {
  const page = 1000;
  const out: ItemRow[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from("inventory_items")
      .select("brand, item_category, garment_category, title, size")
      .not("brand", "is", null)
      .range(from, from + page - 1);
    if (error) {
      console.error(`! inventory_items unreadable at offset ${from}: ${error.message}`);
      return out;
    }
    const rows = (data ?? []) as unknown as ItemRow[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

/** Men / Women when the item's own text says so, else null — never guessed. */
function departmentOf(row: ItemRow): string | null {
  const text = [row.title, row.garment_category, row.item_category, row.size]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
  if (/\b(kids?|youth|junior|boys?|girls?|baby|toddler)\b/.test(text)) return "Kids";
  if (/\b(women'?s?|womens|woman'?s?|ladies|female)\b/.test(text)) return "Women";
  if (/\b(men'?s?|mens|man'?s?|male)\b/.test(text)) return "Men";
  return normalizeDepartment(null);
}

const items = await readItems();

interface BrandStat {
  label: string;
  key: string;
  count: number;
  /** Departments the brand ACTUALLY sells here, by item count. */
  departments: Map<string, number>;
}

const byBrand = new Map<string, BrandStat>();
for (const row of items) {
  const label = (row.brand ?? "").trim();
  if (!label) continue;
  const k = brandKey(label);
  if (!k) continue;
  const stat = byBrand.get(k) ??
    { label, key: k, count: 0, departments: new Map<string, number>() };
  stat.count += 1;
  const dept = departmentOf(row);
  if (dept) stat.departments.set(dept, (stat.departments.get(dept) ?? 0) + 1);
  byBrand.set(k, stat);
}

const ranked = [...byBrand.values()]
  .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  .slice(0, TOP);

// ── 2. What brand_size_charts actually holds ────────────────────────────────

interface ChartRow {
  brand_key: string;
  department: string;
  garment: string;
  verified: boolean | null;
  source_url: string | null;
  measurement_basis: string | null;
}

// `measurement_basis` arrives with migration 00674, which is HELD at the time
// this script was written - so on prod the column does not exist yet, and asking
// for it fails the WHOLE select with 42703. That failure is the dangerous kind:
// it returns zero charts, and zero charts reads as "no brand has a chart", which
// is a plausible-looking answer to exactly the question being asked. So the
// column is optional: ask for it, and on a missing-column error fall back to the
// pre-00674 shape and say so, rather than reporting a fabricated zero.
let basisColumnExists = true;

async function readCharts(): Promise<ChartRow[]> {
  const page = 1000;
  const out: ChartRow[] = [];
  for (let from = 0; ; from += page) {
    const columns = basisColumnExists
      ? "brand_key, department, garment, verified, source_url, measurement_basis"
      : "brand_key, department, garment, verified, source_url";
    const { data, error } = await db
      .from("brand_size_charts")
      .select(columns)
      .range(from, from + page - 1);
    if (error) {
      const missingBasis = basisColumnExists &&
        (error.code === "42703" || /measurement_basis/.test(error.message ?? ""));
      if (missingBasis) {
        console.error(
          "! brand_size_charts.measurement_basis is absent - migration 00674 is " +
            "not applied here. Re-reading without it; the flat-basis counts below " +
            "are UNKNOWN, not zero.",
        );
        basisColumnExists = false;
        from -= page; // retry this same page with the narrower select
        continue;
      }
      console.error(`! brand_size_charts unreadable: ${error.message}`);
      return out;
    }
    const rows = (data ?? []) as unknown as ChartRow[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

const charts = await readCharts();
const chartsByBrand = new Map<string, ChartRow[]>();
for (const chart of charts) {
  const list = chartsByBrand.get(chart.brand_key) ?? [];
  list.push(chart);
  chartsByBrand.set(chart.brand_key, list);
}

// A chart covers tops when its garment scope says so, and bottoms likewise. The
// story asks for both at minimum, so both are reported rather than a single
// "has a chart" flag that a tops-only brand would satisfy.
const TOPS = /top|shirt|tee|blouse|sweater|hoodie|jacket|dress|outerwear/i;
const BOTTOMS = /bottom|pant|jean|short|legging|trouser|skirt|chino/i;

interface Coverage {
  department: string;
  items: number;
  charts: number;
  verified: number;
  tops: boolean;
  bottoms: boolean;
  sourced: number;
  /** null when migration 00674 is not applied where this ran. */
  flatBasis: number | null;
}

interface BrandReport {
  rank: number;
  brand: string;
  key: string;
  items: number;
  coverage: Coverage[];
}

const report: BrandReport[] = ranked.map((stat, i) => {
  const brandCharts = chartsByBrand.get(stat.key) ?? [];
  const departments = [...stat.departments.entries()].sort((a, b) => b[1] - a[1]);
  return {
    rank: i + 1,
    brand: stat.label,
    key: stat.key,
    items: stat.count,
    coverage: departments.map(([department, itemCount]) => {
      const forDept = brandCharts.filter(
        (c) => c.department === department || c.department === "Unisex",
      );
      return {
        department,
        items: itemCount,
        charts: forDept.length,
        verified: forDept.filter((c) => c.verified === true).length,
        tops: forDept.some((c) => TOPS.test(c.garment)),
        bottoms: forDept.some((c) => BOTTOMS.test(c.garment)),
        sourced: forDept.filter((c) => (c.source_url ?? "").trim().length > 0).length,
        flatBasis: basisColumnExists
          ? forDept.filter((c) => c.measurement_basis === "flat").length
          : null,
      };
    }),
  };
});

// ── 3. The headline ─────────────────────────────────────────────────────────

const pairs = report.flatMap((b) => b.coverage.map((c) => ({ brand: b.brand, ...c })));
const summary = {
  brandsRanked: report.length,
  itemsScanned: items.length,
  chartsInDb: charts.length,
  brandDepartmentPairs: pairs.length,
  withAnyChart: pairs.filter((p) => p.charts > 0).length,
  withVerifiedChart: pairs.filter((p) => p.verified > 0).length,
  withTopsAndBottoms: pairs.filter((p) => p.tops && p.bottoms).length,
  withSourceUrl: pairs.filter((p) => p.sourced > 0).length,
  flatBasisCharts: basisColumnExists
    ? charts.filter((c) => c.measurement_basis === "flat").length
    : null,
  measurementBasisKnown: basisColumnExists,
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, report }, null, 2));
} else {
  console.log(`Top ${report.length} brands by inventory_items.brand row count`);
  console.log(`(${items.length} items scanned, ${charts.length} charts in the DB)\n`);
  for (const b of report) {
    const parts = b.coverage.map((c) => {
      const tier = c.verified > 0 ? "verified" : c.charts > 0 ? "unverified" : "NONE";
      const scope = [c.tops ? "tops" : null, c.bottoms ? "bottoms" : null]
        .filter(Boolean)
        .join("+") || "no scope";
      return `${c.department} ${tier} (${scope})`;
    });
    const line = parts.length > 0 ? parts.join(" · ") : "no department readable";
    console.log(`${String(b.rank).padStart(3)}. ${b.brand.padEnd(28)} ${String(b.items).padStart(6)} items  ${line}`);
  }
  console.log("\n── coverage ──");
  console.log(`brand+department pairs           ${summary.brandDepartmentPairs}`);
  console.log(`  with any chart                 ${summary.withAnyChart}`);
  console.log(`  with a VERIFIED chart          ${summary.withVerifiedChart}`);
  console.log(`  covering tops AND bottoms      ${summary.withTopsAndBottoms}`);
  console.log(`  with a source_url              ${summary.withSourceUrl}`);
  console.log(
    `charts recorded as flat basis    ${
      summary.flatBasisCharts ?? "unknown (00674 not applied here)"
    }`,
  );
}
