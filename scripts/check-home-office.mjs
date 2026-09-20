#!/usr/bin/env node
// US-2990 — the simplified home-office deduction, against a real Postgres.
//
// ⚠ THIS NOW RUNS IN CI. The header below used to argue it was deliberately
// kept out of `npm run verify` because "a lane that skips silently when the
// stack is down teaches everyone to ignore it". That argument was wrong, and
// six scripts repeated it before anyone noticed: check-session-revocation and
// check-inventory-writeoffs have always been db-backed, in the db lane, and
// skipped cleanly by the same Docker gate. All six moved into that lane, and
// six hand-written exemptions came out of guard-lane-parity.test.ts.
//
// THE ASSERTION THIS EXISTS FOR: the cap is applied to the SQUARE FOOTAGE
// before the months are prorated, not to the answer afterwards. 400 sq ft for
// six months is 300 capped then halved -- $750. Prorating first and capping
// after gives $1,000. Both look plausible on a screen and only one is right.
//
// Usage:
//   node scripts/check-home-office.mjs [--container <name>]

import { existsSync } from "node:fs";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "home-office.sql");

const psql = psqlTarget();

if (!existsSync(FIXTURE)) {
  console.error(`✗ fixture missing: ${FIXTURE}`);
  process.exit(1);
}

// US-3435: one home for the invocation. `docker exec` was the only path, so
// this read as unrunnable without the Supabase image -- which a cloud session
// cannot pull. It needs a Postgres, not Docker.
const { ok: reached, out: raw } = runFixture(psql, FIXTURE, { args: ["-F", "|"] });
if (!reached) {
  console.error(`\u2717 could not reach ${psql.how}.\n  ${psql.hint}\n  ${raw.split("\n")[0]}`);
  process.exit(2);
}
const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
const failures = [];

function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got ${actual}, expected ${expected}`}`);
  if (!ok) failures.push(label);
}

/** The arithmetic rows are keyed by their leading letter. */
const arith = (letter) =>
  lines.find((l) => l.startsWith(`${letter} `))?.split("|")[1];

console.log("The arithmetic:");
check("300 sq ft all year is the $1,500 maximum", arith("A"), 150000);
check("400 sq ft all year is capped at the same", arith("B"), 150000);

console.log("\nTHE ONE THIS CHECK EXISTS FOR:");
const c = Number(arith("C"));
const ok = c === 75000;
console.log(
  `  ${ok ? "✓" : "✗"} 400 sq ft for six months is $${(c / 100).toFixed(2)}` +
    ` — the cap applies to the FOOTAGE, then the months are prorated.` +
    (ok ? "" : " Prorating first and capping after gives $1,000."),
);
if (!ok) failures.push("cap and proration applied in the wrong order");

console.log("\nOrdinary cases and the boundaries:");
check("120 sq ft all year is $600", arith("D"), 60000);
check("120 sq ft for three months is $150", arith("E"), 15000);
check("zero months deducts nothing", arith("F"), 0);
check("zero square feet deducts nothing", arith("G"), 0);
check(
  "a year before the method existed deducts nothing",
  arith("H"),
  0,
);

console.log("\nIt is Schedule C line 30, not line 28:");
const office = lines.find((l) => l.startsWith("home_office|"))?.split("|");
const rent = lines.find((l) => l.startsWith("rent_property|"))?.split("|");
check("the deduction lands on the home_office account", office?.[0], "home_office");
check("which carries line 30", office?.[1], "30");
check("for $600", office?.[2], "-60000");
check("dated at the end of the tax year", office?.[3], "2025-12-31");
check("and rent stays on its own line 20b", rent?.[1], "20b");

console.log("\nThe double-count guard:");
let overlap = null;
{
  const start = raw.lastIndexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      overlap = JSON.parse(raw.slice(start, end + 1));
    } catch {
      /* not JSON */
    }
  }
}
if (!overlap) {
  console.error("  ✗ no overlap object in the output");
  failures.push("overlap object missing");
} else {
  check("it fires", overlap.overlaps, true);
  check("naming the home office figure", overlap.deduction_cents, 60000);
  check("beside the rent figure", overlap.rent_cents, 40000);
  console.log(
    `  ✓ both numbers are shown side by side ($${(overlap.deduction_cents / 100).toFixed(2)}` +
      ` home office against $${(overlap.rent_cents / 100).toFixed(2)} rent) rather than one being suppressed`,
  );
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\n✓ home office: capped before prorating, on line 30, and the overlap is reported.");
