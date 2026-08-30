#!/usr/bin/env node
// US-2989 — the mileage log, against a real Postgres.
//
// Fifth of the database-backed checks, gated like the others: it needs
// Postgres, so it is not in `npm run verify`.
//
// THE ASSERTION THIS EXISTS FOR: the ledger and the summary reach the SAME
// deduction, to the cent. They compute it by different routes -- one entry per
// trip against one aggregate query -- and the first version of the summary
// rounded once on the total while the ledger rounds per trip. Two 10.4-mile
// trips at 58.5 cents diverged by a cent, and a seller who finds two of our own
// screens disagreeing stops believing both.
//
// Usage:
//   node scripts/check-mileage-log.mjs [--container <name>]

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "mileage-log.sql");

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
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-F", "|"],
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

const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

// The three summary objects, in fixture order: 2022, 2026, 2019.
const objects = [];
{
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
          /* a rate object, not a summary */
        }
        start = -1;
      }
    }
  }
}
const summaries = objects.filter((o) => "deduction_cents" in o);
if (summaries.length < 3) {
  console.error(
    `✗ expected three summaries, parsed ${summaries.length}. Raw tail:\n${raw.slice(-900)}`,
  );
  process.exit(1);
}
const [s2022, s2026, s2019] = summaries;

const failures = [];
function check(label, actual, expected) {
  // Numeric where both sides look numeric: JSON gives 88 for a numeric(9,1) of
  // 88.0, and a string compare would fail on the dropped trailing zero rather
  // than on anything real.
  const bothNumeric =
    actual !== null && actual !== "" && expected !== "" &&
    !Number.isNaN(Number(actual)) && !Number.isNaN(Number(expected));
  const ok = bothNumeric
    ? Number(actual) === Number(expected)
    : String(actual) === String(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got ${actual}, expected ${expected}`}`);
  if (!ok) failures.push(label);
}

// Per-trip ledger rows: "date|miles|cents"
const tripRow = (d) => lines.find((l) => l.startsWith(`${d}|`))?.split("|");

console.log("The rate changed mid-year in 2022, one day apart:");
check("30 June, 100 miles, 58.5 cents", tripRow("2022-06-30")?.[2], "-5850");
check("1 July, 100 miles, 62.5 cents", tripRow("2022-07-01")?.[2], "-6250");
const differ = tripRow("2022-06-30")?.[2] !== tripRow("2022-07-01")?.[2];
console.log(
  `  ${differ ? "✓" : "✗"} identical trips one day apart are valued differently` +
    " — the case a constant cannot express",
);
if (!differ) failures.push("mid-year rate change had no effect");

console.log("\nA rate we do not have is not a rate of zero:");
check("a 2019 trip gets no ledger entry", tripRow("2019-05-01")?.[2], "");
check("and the summary counts it as unrated", s2019.trips_without_a_rate, 1);
check("rather than deducting something", s2019.deduction_cents, 0);
check("while still counting its miles", s2019.total_miles, "88.0");

console.log("\nA provisional rate is used AND disclosed:");
check("the 2026 trip is valued", s2026.deduction_cents, 2940);
check("and flagged provisional", s2026.trips_on_a_provisional_rate, 1);
check("with its miles named", s2026.miles_on_a_provisional_rate, "42.0");

console.log("\nTHE ONE THIS CHECK EXISTS FOR:");
const ledgerLine = lines.find((l) => l.startsWith("ledger 2022 mileage cents|"));
const ledgerCents = Math.abs(Number(ledgerLine?.split("|")[1]));
const agree = ledgerCents === s2022.deduction_cents;
console.log(
  `  ${agree ? "✓" : "✗"} the ledger and the summary reach the same deduction` +
    ` (${ledgerCents} vs ${s2022.deduction_cents} cents)`,
);
if (!agree) failures.push("ledger and summary disagree on the deduction");
check("2022 covers five trips", s2022.trip_count, 5);
check("and 258.1 miles", s2022.total_miles, "258.1");

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `\n✓ mileage: dated rates, provisional disclosed, and the two routes to the` +
    ` deduction agree at ${(ledgerCents / 100).toFixed(2)} dollars.`,
);
