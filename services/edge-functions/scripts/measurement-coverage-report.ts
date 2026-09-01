// US-3037: the gate. How much of the Fit & Measurement Index is real?
//
// The public pages (US-3040, US-3041) must not be built on a table that cannot
// reach its own floor. This script is the evidence for that decision, and it is
// a script rather than a number somebody wrote down because the answer changes
// every day and intuition is wrong about it in both directions.
//
// It reports two halves, and the second is the one that matters before any
// ingestion has run:
//
//   ACTUAL — what garment_measurement_stats says today: how many cohorts clear
//   both floors, broken down by garment group, and the share of observations
//   that resolved to a style rather than falling back to the brand rollup.
//
//   POTENTIAL — the forecast, computed from inventory_items alone. Group every
//   item that HAS a brand and a size by (brand, department, group, size) and
//   count the groups that already hold enough garments from enough distinct
//   sellers. That is the ceiling the index can reach if every one of those
//   garments were measured, and it answers "is this floor reachable at all"
//   without waiting for a backfill.
//
// The two differ on purpose. ACTUAL near zero with POTENTIAL healthy means keep
// going: the data exists and has not been measured yet. Both near zero means
// the floor is out of reach on today's inventory and the public pages should
// not be built, which is exactly the verdict this story is asked for.
//
// READ-ONLY. It writes nothing, so it is safe against prod, which is the only
// place a meaningful answer lives — a local stack has no inventory.
//
//   deno run --allow-net --allow-env services/edge-functions/scripts/measurement-coverage-report.ts [--json] [--top 20]
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. The anon key is not
// enough and never will be: garment_measurements is tenant-scoped and
// garment_measurement_stats is deny-all, so an anon read returns [] whether the
// table is empty or full, which is the one answer this script must not give.

import { createClient } from "@supabase/supabase-js";
import { brandKeyForRaw } from "../src/lib/brand-normalize.ts";
import { normalizeSizeLabel } from "../src/lib/size-systems.ts";
import { measurementGroupForItem } from "../src/lib/measurement-templates.ts";
import {
  MIN_MEASUREMENT_CONTRIBUTORS,
  MIN_MEASUREMENT_SAMPLE,
} from "../src/lib/measurement-aggregate.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const asJson = Deno.args.includes("--json");
const topIdx = Deno.args.indexOf("--top");
const TOP = topIdx >= 0 ? Number(Deno.args[topIdx + 1] ?? 20) : 20;

const PAGE = 1000;

async function readAll<T>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select(select)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`[coverage] ${table} read failed: ${error.message}`);
      return out;
    }
    const page = (data ?? []) as unknown as T[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

// ── ACTUAL ──────────────────────────────────────────────────────────────────

interface StatRow {
  brand_key: string;
  style_key: string;
  measurement_group: string;
  field_key: string;
  sample_count: number;
  contributor_count: number;
  sufficient: boolean;
}
interface ObsRow {
  brand_key: string;
  style_key: string;
}

const stats = await readAll<StatRow>(
  "garment_measurement_stats",
  "brand_key, style_key, measurement_group, field_key, sample_count, contributor_count, sufficient",
);
const observations = await readAll<ObsRow>("garment_measurements", "brand_key, style_key");

const sufficientByGroup = new Map<string, number>();
const cohortsByGroup = new Map<string, number>();
const sufficientByBrand = new Map<string, number>();
for (const s of stats) {
  cohortsByGroup.set(s.measurement_group, (cohortsByGroup.get(s.measurement_group) ?? 0) + 1);
  if (!s.sufficient) continue;
  sufficientByGroup.set(s.measurement_group, (sufficientByGroup.get(s.measurement_group) ?? 0) + 1);
  sufficientByBrand.set(s.brand_key, (sufficientByBrand.get(s.brand_key) ?? 0) + 1);
}

const withStyle = observations.filter((o) => o.style_key !== "").length;
const styleShare = observations.length > 0 ? withStyle / observations.length : 0;

// ── POTENTIAL ───────────────────────────────────────────────────────────────

interface ItemRow {
  user_id: string;
  brand: string | null;
  size: string | null;
  item_category: string | null;
  garment_category: string | null;
  garment_type: string | null;
  title: string | null;
}

const items = await readAll<ItemRow>(
  "inventory_items",
  "user_id, brand, size, item_category, garment_category, garment_type, title",
);

const eligible = items.filter((i) => i.brand && i.size);
const potential = new Map<string, Set<string>>();
const potentialCount = new Map<string, number>();
const potentialBrand = new Map<string, string>();

for (const item of eligible) {
  const bk = brandKeyForRaw(item.brand);
  if (!bk) continue;
  const group = measurementGroupForItem(item);
  const size = normalizeSizeLabel(item.size, group);
  if (!size) continue;
  const cohort = `${bk} ${group} ${size}`;
  potentialBrand.set(cohort, bk);
  potentialCount.set(cohort, (potentialCount.get(cohort) ?? 0) + 1);
  let sellers = potential.get(cohort);
  if (!sellers) potential.set(cohort, sellers = new Set());
  sellers.add(item.user_id);
}

const reachable = [...potential.entries()].filter(([cohort, sellers]) =>
  (potentialCount.get(cohort) ?? 0) >= MIN_MEASUREMENT_SAMPLE &&
  sellers.size >= MIN_MEASUREMENT_CONTRIBUTORS
);

const reachableByBrand = new Map<string, number>();
for (const [cohort] of reachable) {
  const bk = potentialBrand.get(cohort)!;
  reachableByBrand.set(bk, (reachableByBrand.get(bk) ?? 0) + 1);
}

const report = {
  floors: {
    sample: MIN_MEASUREMENT_SAMPLE,
    contributors: MIN_MEASUREMENT_CONTRIBUTORS,
  },
  actual: {
    observations: observations.length,
    cohorts: stats.length,
    sufficient: stats.filter((s) => s.sufficient).length,
    sufficientByGroup: Object.fromEntries(sufficientByGroup),
    cohortsByGroup: Object.fromEntries(cohortsByGroup),
    styleResolvedShare: Number(styleShare.toFixed(3)),
    observationsAtBrandLevel: observations.length - withStyle,
    topBrands: [...sufficientByBrand.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP)
      .map(([brand, cohorts]) => ({ brand, cohorts })),
  },
  potential: {
    items: items.length,
    eligible: eligible.length,
    cohorts: potential.size,
    reachable: reachable.length,
    topBrands: [...reachableByBrand.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP)
      .map(([brand, cohorts]) => ({ brand, cohorts })),
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  Deno.exit(0);
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

console.log(`\nFit & Measurement Index — coverage report`);
console.log(`Floors: ${MIN_MEASUREMENT_SAMPLE} garments from ${MIN_MEASUREMENT_CONTRIBUTORS} sellers\n`);

console.log(`ACTUAL (what is published today)`);
console.log(`  observations            ${report.actual.observations}`);
console.log(`  cohorts                 ${report.actual.cohorts}`);
console.log(`  clearing both floors    ${report.actual.sufficient}`);
console.log(`  style resolved          ${pct(report.actual.styleResolvedShare)} (${report.actual.observationsAtBrandLevel} at brand level)`);
for (const [group, n] of sufficientByGroup) {
  console.log(`    ${group.padEnd(12)} ${n} of ${cohortsByGroup.get(group) ?? 0}`);
}
if (report.actual.topBrands.length > 0) {
  console.log(`  top brands by publishable cohorts:`);
  for (const b of report.actual.topBrands) console.log(`    ${b.brand.padEnd(24)} ${b.cohorts}`);
}

console.log(`\nPOTENTIAL (the ceiling, if every eligible garment were measured)`);
console.log(`  inventory items         ${report.potential.items}`);
console.log(`  with a brand AND size   ${report.potential.eligible}`);
console.log(`  distinct cohorts        ${report.potential.cohorts}`);
console.log(`  cohorts that could clear both floors  ${report.potential.reachable}`);
if (report.potential.topBrands.length > 0) {
  console.log(`  top brands by reachable cohorts:`);
  for (const b of report.potential.topBrands) console.log(`    ${b.brand.padEnd(24)} ${b.cohorts}`);
}

console.log(`\nVERDICT`);
if (report.actual.sufficient >= 24) {
  console.log(`  SHIP. ${report.actual.sufficient} cohorts clear both floors.`);
} else if (report.potential.reachable >= 24) {
  console.log(
    `  NOT YET, BUT REACHABLE. ${report.actual.sufficient} published now, ` +
      `${report.potential.reachable} cohorts could clear the floors once measured.`,
  );
  console.log(`  The gap is measurement, not inventory. Run the backfill and the aggregate.`);
} else {
  const n = report.potential.reachable;
  console.log(
    `  DO NOT BUILD THE PUBLIC PAGES. Only ${n} cohort${n === 1 ? "" : "s"} ` +
      `could EVER clear the floors on today's inventory.`,
  );
  console.log(`  The product half (US-3039) still stands on its own.`);
}
console.log();
