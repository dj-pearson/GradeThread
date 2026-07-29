// US-2215: emit the brand_size_charts size_system / size_class migration.
//
// A SEPARATE file from 00498's backfill, deliberately. 00498 is already
// committed and packaged in PENDING_MIGRATIONS.md as a held migration; editing
// it would change SQL an operator may already have applied. This adds the two
// columns and then fills them for the rows 00498 inserted.
//
// Regenerate with:
//   deno run --allow-read --allow-write scripts/gen-size-systems-migration.mjs
//
// `size-systems-parity_test.ts` re-derives the same SQL and fails if the
// committed file drifts from the charts.

import { SIZING_CHARTS } from "../services/edge-functions/src/lib/sizing-charts.ts";
import { brandKey } from "../services/edge-functions/src/lib/brand-normalize.ts";
import {
  detectSizeClass,
  detectSizeSystem,
} from "../services/edge-functions/src/lib/size-systems.ts";

const MIGRATION = "00499";
const OUT = new URL(
  `../supabase/migrations/${MIGRATION}_size_systems.sql`,
  import.meta.url,
);

function q(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** One chart's derived (system, class), or null when nothing is derivable. */
export function chartSystemRow(chart) {
  const system = detectSizeSystem(chart);
  const cls = detectSizeClass(chart);
  // Nothing to say: no readable system and an ordinary standard chart.
  if (system === null && cls === "standard") return null;
  return {
    key: brandKey(chart.brand),
    department: chart.department,
    garment: chart.garment,
    system,
    cls,
  };
}

export function buildSql(charts) {
  const rows = charts.map(chartSystemRow).filter(Boolean);
  const values = rows
    .map((r) =>
      `  (${q(r.key)}, ${q(r.department)}, ${q(r.garment)}, ${
        r.system ? q(r.system) : "NULL"
      }, ${r.cls ? q(r.cls) : "NULL"})`
    )
    .join(",\n");

  const withSystem = rows.filter((r) => r.system).length;
  const nonStandard = rows.filter((r) => r.cls && r.cls !== "standard").length;
  const unknownClass = rows.filter((r) => r.cls === null).length;

  return `-- US-2215: give brand_size_charts a size SYSTEM and a size CLASS.
--
-- GENERATED FILE — do not hand-edit. Regenerate with:
--   deno run --allow-read --allow-write scripts/gen-size-systems-migration.mjs
--
-- WHY: the chart shape had department and a free-text garment scope and nowhere
-- to record WHICH NATIONAL SYSTEM a size label is written in, so the corpus
-- encoded it inside the label itself — "UK 10 (US 6)", "IT 48 (US 38)",
-- "FR 36 (US 4)", "JP L (=US M)". 115 of ${charts.length} charts do this. Every one of
-- those parentheses is a workaround for a missing field.
--
-- The prose is KEPT. This migration adds the structured field beside it; it
-- does not rewrite a single size label or note, because those strings are what
-- the model actually reads and re-authoring 115 of them is a separate, riskier
-- change that deserves its own eval.
--
-- Values are DERIVED, not asserted: size-systems.ts:detectSizeSystem reads the
-- system off the labels only when they state it, and returns NULL otherwise. A
-- chart of bare numbers stays NULL because a bare "6" could be US or UK and
-- nothing in the row says which. NULL means "not recorded", never "US".
--
-- Derived here: ${withSystem} charts with a readable system, ${nonStandard} non-standard size class,
-- ${unknownClass} with an ambiguous class (a scope naming several — the Talbots case, whose
-- scope reads "Misses / Petite / Plus" and which is exactly the folding the
-- size_class column exists to end).
--
-- Risk: LOW. Two additive nullable text columns on a global reference table
-- with deny-all RLS, plus an UPDATE that only sets them. No tenant data, no
-- trigger, no view change. Idempotent and re-run safe.

alter table public.brand_size_charts
  add column if not exists size_system text;
alter table public.brand_size_charts
  add column if not exists size_class  text;

comment on column public.brand_size_charts.size_system is
  'US-2215 national system the size labels are written in (US|UK|EU|IT|FR|JP|AU|alpha). NULL = not recorded, NOT an implied US.';
comment on column public.brand_size_charts.size_class is
  'US-2215 extended size class (standard|plus|petite|tall|big_and_tall|maternity). NULL = the chart names several and cannot be reduced to one.';

update public.brand_size_charts AS t
   set size_system = v.size_system,
       size_class  = v.size_class,
       updated_at  = now()
  from (values
${values}
  ) AS v(brand_key, department, garment, size_system, size_class)
 where t.brand_key  = v.brand_key
   and t.department = v.department
   and t.garment    = v.garment;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('${MIGRATION}') on conflict do nothing;
`;
}

if (import.meta.main) {
  const sql = buildSql(SIZING_CHARTS);
  await Deno.writeTextFile(OUT, sql);
  const n = SIZING_CHARTS.map(chartSystemRow).filter(Boolean).length;
  console.log(`✓ wrote ${n} system/class rows to ${OUT.pathname.split("/").pop()}`);
}
