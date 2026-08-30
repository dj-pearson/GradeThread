#!/usr/bin/env node
// US-2994 — bank statement matching, against a real Postgres.
//
// Eighth of the db-backed money checks, registered in the db lane with the rest.
//
// THE TWO ASSERTIONS THIS EXISTS FOR:
//
//   Re-importing an overlapping range must not duplicate. Widening the export
//   range is the normal thing sellers do when they think something is missing,
//   and an import that doubles those rows is worse than one that refuses.
//
//   An expense already matched to one statement row must not be offered to
//   another. One expense cannot satisfy two statement lines -- and two lines
//   for one expense is precisely the double payment a bank import exists to
//   catch, so offering it would hide the thing it was supposed to find.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "statement-import.sql");

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
const failures = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got ${actual}, expected ${expected}`}`);
  if (!ok) failures.push(label);
}
const val = (q) => lines.find((l) => l.startsWith(`${q}|`))?.split("|")[1];
const tagged = (tag) => lines.filter((l) => l.startsWith(`${tag}|`)).map((l) => l.split("|"));

console.log("Re-importing an overlapping range (AC3):");
check("three rows on the first import", val("rows after first import"), 3);
// Two of the three re-imported rows were already known; only the new one lands.
check(
  "a re-import with two duplicates and one new row adds exactly one",
  val("rows after overlapping re-import"),
  4,
);

console.log("\nMatching offers the right candidates:");
const cands = tagged("candidate");
check("two expenses of the same amount are inside the window", cands.length, 2);
check("the closer date ranks first", cands[0]?.[3], "1");
check("and scores higher", Number(cands[0]?.[4]) > Number(cands[1]?.[4]), true);
// The third expense is the same amount in JANUARY. A window that let it through
// would offer a seller a two-month-old purchase as a match.
check("an expense outside the date window is not offered at all", cands.length, 2);

console.log("\nA row with no expense at its amount:");
check("offers nothing rather than a near miss", tagged("no candidates").length, 0);

console.log("\nTHE ONE THIS CHECK EXISTS FOR:");
const second = tagged("second uline row candidate");
const takenOffered = second.some((r) => r[2] === "2026-03-04");
console.log(
  `  ${!takenOffered ? "✓" : "✗"} an expense already matched to another row is NOT offered again`,
);
if (takenOffered) failures.push("an already-matched expense was offered twice");
check("the remaining unmatched expense still is", second.length, 1);
check("and it is the one that was never taken", second[0]?.[2], "2026-03-12");

console.log("\nThe counts add up (AC4):");
let summary = null;
{
  const start = raw.lastIndexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      summary = JSON.parse(raw.slice(start, end + 1));
    } catch {
      /* not JSON */
    }
  }
}
if (!summary) {
  console.error("  ✗ no summary object in the output");
  failures.push("summary missing");
} else {
  check("five rows total", summary.total, 5);
  check("one matched", summary.matched, 1);
  check("four still to review", summary.unreviewed, 4);
  check("none ignored", summary.ignored, 0);
  // $47.83 + $124.99 + $9.99. The $500 deposit is money coming IN and is not
  // an expense candidate.
  check("only money LEAVING counts as unaccounted for", summary.unreviewed_spend_cents, 18281);
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\n✓ statement import: re-imports do not duplicate, and a matched expense cannot be matched twice.");
