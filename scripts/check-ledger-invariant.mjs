#!/usr/bin/env node
// US-2984 AC4 — run the ledger invariant against a real Postgres.
//
// ⚠ THIS NOW RUNS IN CI. The header below used to argue it was deliberately
// kept out of `npm run verify` because "a lane that skips silently when the
// stack is down teaches everyone to ignore it". That argument was wrong, and
// six scripts repeated it before anyone noticed: check-session-revocation and
// check-inventory-writeoffs have always been db-backed, in the db lane, and
// skipped cleanly by the same Docker gate. All six moved into that lane, and
// six hand-written exemptions came out of guard-lane-parity.test.ts.
//
// The claim this checks is the one the whole Books and Taxes epic rests on:
// ONE NUMBER IS ONE NUMBER. public.ledger_entries and public.finances_dashboard
// derive profit by completely different routes, and if they disagree by a cent
// the ledger is wrong -- the dashboard is what sellers have been reading for
// months.
//
// Usage:
//   node scripts/check-ledger-invariant.mjs            # local supabase container
//   node scripts/check-ledger-invariant.mjs --container my_db_container

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "ledger-invariant.sql");

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

// The reconciliation is the last JSON object the script prints.
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
  ledger_sale_net_cents: ledger,
  dashboard_net_cents: dashboard,
  overhead_cents: overhead,
  true_net_cents: trueNet,
  excluded_cents: excluded,
  entry_count: entries,
} = result;

const money = (c) => `$${(c / 100).toFixed(2)}`;

console.log(`  entries written        ${entries}`);
console.log(`  ledger net (sales)     ${money(ledger)}`);
console.log(`  finances_dashboard net ${money(dashboard)}`);
console.log(`  variance               ${money(variance)}`);
console.log(`  operating expenses     ${money(overhead)}`);
console.log(`  net after overhead     ${money(trueNet)}`);
console.log(`  excluded (sales tax)   ${money(excluded)}`);

// A zero-entry ledger agrees with a zero dashboard, which would let a broken
// derivation report success. Fail on it explicitly.
if (!entries || entries < 10) {
  console.error(
    `\n✗ the fixture produced only ${entries} entries. It seeds at least ten;` +
      ` a derivation that writes nothing agrees with everything.`,
  );
  process.exit(1);
}

if (!agrees) {
  console.error(
    `\n✗ ledger invariant BROKEN: off by ${money(variance)}.` +
      `\n  The ledger is wrong, not the dashboard.`,
  );
  process.exit(1);
}

console.log("\n✓ ledger invariant: the two agree to the cent.");
