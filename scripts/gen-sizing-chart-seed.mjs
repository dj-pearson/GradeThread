// US-2214: emit the brand_size_charts backfill from the in-code SIZING_CHARTS.
//
// The in-code seed is the source; the migration is derived. Hand-writing 292
// rows would guarantee drift on the first edit, and the whole point of the story
// is that code and DB had already drifted apart silently.
//
// Regenerate with:
//   deno run --allow-read --allow-write scripts/gen-sizing-chart-seed.mjs
//
// This is a Deno script, not Node, because SIZING_CHARTS lives in the edge
// service's TypeScript and is imported directly rather than re-parsed. It is
// pure data with no network imports, so it loads without the edge's dependency
// tree.
//
// The generated file is committed. `sizing-chart-parity_test.ts` re-derives the
// same rows and fails if the committed SQL no longer matches the code, so a
// chart edit that forgets to regenerate cannot reach prod.

import { SIZING_CHARTS } from "../services/edge-functions/src/lib/sizing-charts.ts";
import { brandKey } from "../services/edge-functions/src/lib/brand-normalize.ts";

const MIGRATION = "00498";
const OUT = new URL(
  `../supabase/migrations/${MIGRATION}_sizing_charts_backfill.sql`,
  import.meta.url,
);

/** Single-quote escape for a SQL literal. */
function q(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** text[] literal, or the empty-array default. */
function arr(values) {
  if (!values || values.length === 0) return `'{}'::text[]`;
  return `ARRAY[${values.map(q).join(",")}]::text[]`;
}

/**
 * Build one VALUES tuple. `rows` goes in a dollar-quoted JSON literal so the
 * measurement strings never need escaping — the same form the hand-written
 * packs use.
 */
export function chartToValues(chart) {
  const key = brandKey(chart.brand);
  const json = JSON.stringify(chart.rows);
  if (json.includes("$json$")) {
    throw new Error(`chart ${key} contains the dollar-quote delimiter`);
  }
  return [
    "  (",
    [
      q(key),
      q(chart.brand),
      arr(chart.brandMatch),
      q(chart.department),
      q(chart.garment),
      arr(chart.categoryMatch),
      `$json$${json}$json$::jsonb`,
      chart.note ? q(chart.note) : "NULL",
      `NULL`, // source_url — the in-code seed carries none; see the header note
      `NULL`, // confidence — deliberately unset, NOT invented
      "false", // verified — a backfill is not a human verification
      q(`migration:${MIGRATION}`),
    ].join(", "),
    ")",
  ].join("");
}

export function buildSql(charts) {
  const values = charts.map(chartToValues).join(",\n");
  return `-- US-2214: backfill brand_size_charts from the in-code SIZING_CHARTS seed.
--
-- GENERATED FILE — do not hand-edit. Regenerate with:
--   deno run --allow-read --allow-write scripts/gen-sizing-chart-seed.mjs
--
-- WHY: lib/sizing-charts.ts carried ${charts.length} charts across ${
    new Set(charts.map((c) => c.brand)).size
  } brands and only a
-- couple of dozen had ever been seeded into brand_size_charts, so the DB-first
-- resolver fell through to the frozen in-code copy for almost every brand — and
-- silently, because the fallback always returns something. The admin curation
-- surface (US-1715) had nothing to edit for those brands.
--
-- WHAT THIS IS NOT: a verification pass. Every row lands with
-- verified = false, confidence = NULL and source_url = NULL, because the
-- in-code seed carries no per-chart provenance to copy. These are the values
-- the resolver has always been using; this migration only moves them somewhere
-- an operator can correct them. Do NOT read verified=false as "suspect" — read
-- it as "not yet reviewed by a human", which was already true.
--
-- Conflict target is the existing brand_size_charts_key_idx
-- (brand_key, department, garment). ON CONFLICT DO NOTHING, deliberately: the
-- hand-written packs (00447 onward) carry real source_url + confidence values
-- and MUST NOT be overwritten by this unsourced backfill. Where a pack already
-- seeded a chart, the pack wins.
--
-- Risk: LOW. Insert-only into a global reference table with deny-all RLS and no
-- tenant data. Idempotent and re-run safe.

insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
${values}
on conflict (brand_key, department, garment) do nothing;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('${MIGRATION}') on conflict do nothing;
`;
}

if (import.meta.main) {
  const sql = buildSql(SIZING_CHARTS);
  await Deno.writeTextFile(OUT, sql);
  console.log(
    `✓ wrote ${SIZING_CHARTS.length} charts to ${OUT.pathname.split("/").pop()}`,
  );
}
