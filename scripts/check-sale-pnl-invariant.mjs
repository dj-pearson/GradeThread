#!/usr/bin/env node
// US-3018 -- run the sale_pnl invariant against a real Postgres.
//
// public.sale_pnl is a THIRD route to a number two other routes already
// produce: finances_dashboard (00143) and the ledger (00685). A third route
// that disagrees by a cent is a team report quietly contradicting the P&L, and
// no amount of source scanning can see it -- the two derivations are separate
// SQL, and both are correct-looking.
//
// The trap this exists for specifically: 00143's per-sale `pnl_net` column is
// NOT the dashboard's net. The summary subtracts `ship_extra` on top of it.
// Copying `pnl_net` into a view drifts on every account that still has rows in
// the legacy shipments table, and on no other account -- so it passes locally,
// passes in CI, and is wrong for the sellers who have been here longest.
//
// Usage:
//   node scripts/check-sale-pnl-invariant.mjs
//   node scripts/check-sale-pnl-invariant.mjs --container my_db_container

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "sale-pnl-invariant.sql");

const args = process.argv.slice(2);
const containerAt = args.indexOf("--container");
const container =
  containerAt >= 0 ? args[containerAt + 1] : "supabase_db_gradethread";

if (!existsSync(FIXTURE)) {
  console.error(`✗ fixture missing: ${FIXTURE}`);
  process.exit(1);
}

let raw;
try {
  raw = execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A"],
    { input: readFileSync(FIXTURE, "utf8"), encoding: "utf8" },
  );
} catch (err) {
  console.error(
    `✗ could not reach Postgres in container "${container}".\n` +
      `  Start it with: docker start ${container}\n` +
      `  ${err.message?.split("\n")[0] ?? err}`,
  );
  process.exit(2);
}

const start = raw.lastIndexOf("{");
const end = raw.lastIndexOf("}");
if (start < 0 || end < start) {
  console.error("✗ no reconciliation object in the output. Raw tail:\n" + raw.slice(-800));
  process.exit(1);
}

let result;
try {
  result = JSON.parse(raw.slice(start, end + 1));
} catch (err) {
  console.error("✗ reconciliation output was not JSON: " + err.message);
  process.exit(1);
}

const {
  agrees,
  variance_cents: variance,
  view_net_cents: view,
  dashboard_net_cents: dashboard,
  row_count: rows,
  sourcer_count: sourcers,
  dan_rows: danRows,
  unassigned_rows: unassignedRows,
  ghost_rows: ghostRows,
  source_keys: sourceKeys,
} = result;

const money = (c) => `$${(c / 100).toFixed(2)}`;

console.log(`  sale_pnl rows          ${rows}`);
console.log(`  distinct sourcers      ${sourcers}`);
console.log(`  sale_pnl net           ${money(view)}`);
console.log(`  finances_dashboard net ${money(dashboard)}`);
console.log(`  variance               ${money(variance)}`);
console.log(`  source keys            ${JSON.stringify(sourceKeys)}`);

// The fixture seeds three completed sales and one cancelled one. A view that
// returns nothing agrees with a dashboard that returns nothing, so pin the
// shape before trusting the number.
if (rows !== 3) {
  console.error(
    `\n✗ expected 3 completed sales in sale_pnl, got ${rows}.` +
      ` The cancelled sale must be excluded and the other three must be present.`,
  );
  process.exit(1);
}

if (ghostRows !== 0) {
  console.error(
    `\n✗ the cancelled sale leaked into the view: ${ghostRows} row(s) for 'Ghost'.`,
  );
  process.exit(1);
}

// 'Dan' and 'dan' are one person. Two rows under one key, and exactly two
// distinct keys overall ('dan' and 'unassigned').
if (danRows !== 2) {
  console.error(
    `\n✗ 'Dan' and 'dan' did not collapse: expected 2 rows on sourcer_key 'dan', got ${danRows}.`,
  );
  process.exit(1);
}

if (unassignedRows !== 1) {
  console.error(
    `\n✗ a NULL sourced_by must land in 'Unassigned': expected 1 row, got ${unassignedRows}.`,
  );
  process.exit(1);
}

if (sourcers !== 2) {
  console.error(
    `\n✗ expected 2 distinct sourcers ('dan' and 'unassigned'), got ${sourcers}.`,
  );
  process.exit(1);
}

// Both fallback rungs of the source chain must be exercised: the sources.name
// row and the acquired_source text.
const keys = Array.isArray(sourceKeys) ? sourceKeys : [];
for (const expected of ["Eastside Estate Sales", "Goodwill on Main", "Unknown"]) {
  if (!keys.includes(expected)) {
    console.error(
      `\n✗ source_key fallback chain broken: expected ${JSON.stringify(expected)} among ${JSON.stringify(keys)}.`,
    );
    process.exit(1);
  }
}

if (!agrees) {
  console.error(
    `\n✗ sale_pnl invariant BROKEN: off by ${money(variance)}.` +
      `\n  sale_pnl is wrong, not finances_dashboard.` +
      `\n  The usual cause is copying 00143's pnl_net column, which omits the` +
      `\n  legacy shipments term the dashboard subtracts separately.`,
  );
  process.exit(1);
}

console.log("\n✓ sale_pnl invariant: the view and finances_dashboard agree to the cent.");
