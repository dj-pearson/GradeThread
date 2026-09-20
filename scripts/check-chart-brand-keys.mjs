#!/usr/bin/env node
// US-3443 -- every brand_size_charts row must carry the brand_key the resolver
// will compute, or the chart is in the table and unreachable from grading.
//
// THE DEFECT THIS WAS WRITTEN FOR, measured on a cluster carrying all the
// migrations. Four rows were duplicated under two different keys:
//
//   fjallraven | Fjällräven | Men   | Apparel (EU numeric ...)   source_url set
//   fjllrven   | Fjällräven | Men   | Apparel (EU numeric ...)   no source_url
//   kuhl       | Kühl       | Men   | Apparel (US alpha tops...) source_url set
//   khl        | Kühl       | Men   | Apparel (US alpha tops...) no source_url
//
// The rows are byte-identical apart from source_url and confidence. brandKey is
// `raw.toLowerCase().replace(/[^a-z0-9]/g, "")`, which DROPS an accented letter
// rather than transliterating it, so "Kühl" keys as `khl`. 00472 wrote `kuhl`
// by hand and 00498's generator wrote `khl` from the seed. The resolver does
// `.eq("brand_key", brandKey(canonicalizeBrand(brand)))`, so the SOURCED rows
// were the unreachable ones and grading served the unsourced approximations.
//
// WHY A DATABASE CHECK RATHER THAN A SOURCE SCAN. The keys are written by hand
// in some migrations and computed by a generator in others, and a later
// migration can change a row without touching either. The table is the only
// place the question has one answer.
//
// WHAT IT DOES NOT CHECK. `canonicalizeBrand` is not applied here: the row's
// own `brand_label` IS the canonical name, so brandKey(label) is the whole
// rule. If a label is ever written non-canonically that is a different defect
// and this check will report it, which is the right direction.
//
// Usage:
//   node scripts/check-chart-brand-keys.mjs --dsn "postgresql://..."
//   node scripts/check-chart-brand-keys.mjs                  # docker
//   node scripts/check-chart-brand-keys.mjs --container my_db
//
// Read-only: one SELECT, no transaction, no writes.

import { psqlTarget, looksUnreachable } from "./lib/psql-target.mjs";
import { spawnSync } from "node:child_process";

/** The resolver's own key function (brand-normalize.ts), copied because that
 *  file is Deno TypeScript and this is node. Four lines, pinned by a test. */
export function brandKey(raw) {
  return String(raw).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Rows whose stored key deliberately differs from brandKey(label).
 *
 * These are the "convention" pseudo-brands from 00581 and 00583: a chart for a
 * sizing CONVENTION rather than a brand, whose label reads like a sentence.
 * They are reachable in the admin KB (which takes the key from the URL) and NOT
 * from grading, which is a real question and is US-3443's, not this check's.
 * Named here so the check reports a NEW one; shrink-only, so fixing one forces
 * its removal from this list.
 */
export const KNOWN_CONVENTION_KEYS = [
  "golfshoewidth",
  "tailoringmenswear",
  "westernbootwidth",
];

const SQL = `
select brand_key || E'\\t' || brand_label || E'\\t' || department || E'\\t' || garment
  from public.brand_size_charts
 order by brand_key, department, garment;
`;

/** Rows whose key the resolver cannot compute, minus the known conventions. */
export function unreachableRows(rows, known = KNOWN_CONVENTION_KEYS) {
  const allow = new Set(known);
  return rows.filter((r) => brandKey(r.label) !== r.key && !allow.has(r.key));
}

/** The same chart stored twice under two different keys. */
export function duplicateCharts(rows) {
  const byChart = new Map();
  for (const r of rows) {
    const k = `${r.label}\u0000${r.department}\u0000${r.garment}`;
    if (!byChart.has(k)) byChart.set(k, new Set());
    byChart.get(k).add(r.key);
  }
  return [...byChart.entries()]
    .filter(([, keys]) => keys.size > 1)
    .map(([k, keys]) => {
      const [label, department, garment] = k.split("\u0000");
      return { label, department, garment, keys: [...keys].sort() };
    });
}

/** Baseline entries that no longer match a real row. */
export function staleKnown(rows, known = KNOWN_CONVENTION_KEYS) {
  const live = new Set(rows.filter((r) => brandKey(r.label) !== r.key).map((r) => r.key));
  return known.filter((k) => !live.has(k));
}

export function parseRows(out) {
  const rows = [];
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length !== 4) continue;
    const [key, label, department, garment] = parts.map((p) => p.trim());
    if (!key || !label) continue;
    rows.push({ key, label, department, garment });
  }
  return rows;
}

function main() {
  const psql = psqlTarget();
  const res = spawnSync(psql.cmd, [...psql.argv, "-c", SQL], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (looksUnreachable(out, res.status)) {
    console.error(
      `✗ could not reach ${psql.how}.\n  ${psql.hint}\n  ` +
        (out.split("\n").find(Boolean) ?? "no output"),
    );
    process.exit(2);
  }

  const rows = parseRows(out);
  // Vacuity floor. An empty or unparsed result reports a clean table.
  if (rows.length < 100) {
    console.error(
      `✗ only ${rows.length} chart rows parsed - the query or the parse ` +
        `broke, and every assertion below would pass over nothing.`,
    );
    process.exit(1);
  }

  const unreachable = unreachableRows(rows);
  const dupes = duplicateCharts(rows);
  const stale = staleKnown(rows);
  let bad = 0;

  if (unreachable.length > 0) {
    bad++;
    console.error(
      `✗ ${unreachable.length} chart row(s) carry a brand_key the resolver ` +
        `cannot compute, so grading can never read them:`,
    );
    for (const r of unreachable) {
      console.error(
        `    ${r.key}  (label "${r.label}" keys as "${brandKey(r.label)}")  ` +
          `${r.department} | ${r.garment}`,
      );
    }
  }

  if (dupes.length > 0) {
    bad++;
    console.error(`✗ ${dupes.length} chart(s) stored under two keys at once:`);
    for (const d of dupes) {
      console.error(`    ${d.label} | ${d.department} | ${d.garment}  ->  ${d.keys.join(" and ")}`);
    }
  }

  if (stale.length > 0) {
    bad++;
    console.error(
      `✗ KNOWN_CONVENTION_KEYS names ${stale.length} key(s) that no longer ` +
        `differ from brandKey(label): ${stale.join(", ")}. Delete them - this ` +
        `list may only shrink.`,
    );
  }

  if (bad > 0) process.exit(1);
  console.log(
    `✓ chart brand keys: ${rows.length} rows, every key is what the ` +
      `resolver computes (${KNOWN_CONVENTION_KEYS.length} convention keys named), ` +
      `no chart stored twice`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("check-chart-brand-keys.mjs")) main();
