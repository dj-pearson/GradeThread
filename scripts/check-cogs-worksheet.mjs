#!/usr/bin/env node
// US-2986 — run the COGS worksheet against a real Postgres.
//
// Companion to scripts/check-ledger-invariant.mjs, and gated the same way: it
// needs a database, so it is NOT in `npm run verify`. A lane that skips
// silently when the stack is down teaches everyone to ignore it.
//
// What it asserts, and why each one is here:
//
//   - the two snapshots hold the right items, so one year's ending inventory
//     really is the next year's beginning inventory;
//   - a snapshot does not move when acquired_price is edited afterwards, which
//     is the whole reason the table exists;
//   - 2025 reconciles (variance 0) and 2026 does NOT (variance -$50), because a
//     check that cannot fail is not a check.
//
// Usage:
//   node scripts/check-cogs-worksheet.mjs [--container <name>]

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "cogs-worksheet.sql");

const args = process.argv.slice(2);
const at = args.indexOf("--container");
const container = at >= 0 ? args[at + 1] : "supabase_db_gradethread";

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

// Two worksheet objects come back, 2025 then 2026, each pretty-printed.
const objects = [];
let depth = 0;
let start = -1;
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === "{") {
    if (depth === 0) start = i;
    depth++;
  } else if (raw[i] === "}") {
    depth--;
    if (depth === 0 && start >= 0) {
      try {
        objects.push(JSON.parse(raw.slice(start, i + 1)));
      } catch {
        // A nested object inside a worksheet; the outer parse covers it.
      }
      start = -1;
    }
  }
}

if (objects.length < 2) {
  console.error(
    `✗ expected two worksheets, parsed ${objects.length}. Raw tail:\n${raw.slice(-800)}`,
  );
  process.exit(1);
}

const [y2025, y2026] = objects;
const money = (c) => `$${(c / 100).toFixed(2)}`;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? "✓" : "✗"} ${label}  ${ok ? "" : `got ${actual}, expected ${expected}`}`);
  if (!ok) failures.push(label);
}

console.log("2025 (three items bought, one sold):");
check("beginning inventory is nothing", y2025.line_35_beginning_cents, 0);
check("purchases are $125", y2025.line_36_purchases_cents, 12500);
check("ending inventory is $85 (items B and C)", y2025.line_41_ending_cents, 8500);
check("COGS is $40 (item A)", y2025.line_42_cogs_cents, 4000);
check("the ledger agrees", y2025.variance_cents, 0);

console.log("\n2026 (item C sold, item D has no cost, item F has a wrong date):");
check(
  "beginning inventory carries 2025's ending figure",
  y2026.line_35_beginning_cents,
  y2025.line_41_ending_cents,
);
check("ending inventory is $25 (item B alone)", y2026.line_41_ending_cents, 2500);
check("worksheet COGS is $60", y2026.line_42_cogs_cents, 6000);
check("ledger cost basis is $110", y2026.sold_cost_basis_cents, 11000);
check("the variance fires at -$50", y2026.variance_cents, -5000);
check(
  "one purchase had no cost basis and is counted",
  y2026.items_without_cost.purchases,
  1,
);

console.log("\nThe snapshot survived an edit to acquired_price:");
const snapshotHeld = /the 2026 snapshot total is\|8500/.test(raw.replace(/\s*\|\s*/g, "|"));
console.log(
  `  ${snapshotHeld ? "✓" : "✗"} item B was edited to $999 and the snapshot still reads $85`,
);
if (!snapshotHeld) failures.push("snapshot moved after an acquired_price edit");

console.log(
  `\n2026 worksheet COGS ${money(y2026.line_42_cogs_cents)} against ledger ` +
    `${money(y2026.sold_cost_basis_cents)} — variance ${money(y2026.variance_cents)}.`,
);

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\n✓ COGS worksheet: every check passed, including the one that must fail.");
