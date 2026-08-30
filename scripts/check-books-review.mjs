#!/usr/bin/env node
// US-2992 — the books review queue, against a real Postgres.
//
// Seventh of the db-backed money checks, and it runs in the db lane with the
// others rather than carrying an exemption.
//
// THE ASSERTIONS THIS EXISTS FOR ARE THE NEGATIVE ONES. Anyone can make a queue
// find problems. The three that must stay QUIET are what decides whether a
// seller opens it twice: a local cash sale genuinely has no fees, a $12 expense
// is under the substantiation threshold, and an item with a real cost basis is
// simply fine. A queue that cries wolf gets ignored, and then the real issue in
// it goes unread too.
//
// Usage:
//   node scripts/check-books-review.mjs [--container <name>]

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "books-review.sql");

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

// The queue is the one JSON ARRAY in the output.
let queue = null;
{
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      queue = JSON.parse(raw.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
}
if (!Array.isArray(queue)) {
  console.error(`✗ could not parse the queue. Raw tail:\n${raw.slice(-900)}`);
  process.exit(1);
}

const failures = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got ${actual}, expected ${expected}`}`);
  if (!ok) failures.push(label);
}
const val = (q) => lines.find((l) => l.startsWith(`${q}|`))?.split("|")[1];
const of = (kind) => queue.filter((i) => i.kind === kind);

console.log("Every issue kind fires:");
for (const kind of [
  "no_cost_basis",
  "uncategorised",
  "sale_without_fees",
  "unmatched_payout",
  "missing_receipt",
  "no_inventory_snapshot",
  "archived_no_reason",
]) {
  check(`${kind} is found`, of(kind).length >= 1, true);
}

console.log("\nTHE ONES THAT MUST STAY QUIET:");
// Six seeded issues and nothing else. If a false positive crept in, this is
// where it shows up as a seventh.
check("exactly seven issues, no more", queue.length, 7);
check(
  "a local cash sale with no fees is NOT flagged",
  of("sale_without_fees").length,
  1,
);
check(
  "a $12 expense is under the receipt threshold and is NOT flagged",
  of("missing_receipt").length,
  1,
);
check(
  "the five items WITH a cost basis are NOT flagged",
  of("no_cost_basis").length,
  1,
);
// US-3007. Both negatives matter: an answered item is not a question, and an
// item that SOLD left inventory by a route the snapshot already handles, so
// asking why it was archived afterwards is noise. Without these the branch
// would report every archived item for ever, which is how a review queue stops
// being read.
check(
  "only the UNANSWERED archived item is flagged",
  of("archived_no_reason").length,
  1,
);
check(
  "the archived item's impact is its own cost, exactly",
  of("archived_no_reason")[0]?.impact_cents,
  5500,
);

console.log("\nImpact is exact where it can be:");
check("an unsorted $55 expense costs the whole $55", of("uncategorised")[0]?.impact_cents, 5500);
check("an orphan payout carries its own amount", of("unmatched_payout")[0]?.impact_cents, 24500);
check("a $120 receipt gap carries $120", of("missing_receipt")[0]?.impact_cents, 12000);

console.log("\nAnd HONESTLY UNKNOWN where it cannot be:");
const noCost = of("no_cost_basis")[0];
check("a missing cost basis has no exact impact", noCost?.impact_cents, "null");
// The seller's five priced sales are all 40% cost-to-price, so a $200 sale
// estimates at $80. Derived from their OWN history rather than a made-up rate.
check("the seller's median cost ratio is 40%", val("median ratio bps"), 4000);
check("so a $200 sale estimates at $80", noCost?.estimated_impact_cents, 8000);

console.log("\nOrdered by what it costs to leave alone, not by ease of fix:");
const severities = queue.map((i) => i.severity);
const sorted = [...severities].sort((a, b) => a - b);
check("severity ascending", JSON.stringify(severities), JSON.stringify(sorted));
check("a missing cost basis is the most severe", queue[0]?.kind, "no_cost_basis");

console.log("\nDismissing is reversible and recorded:");
check("seven before", val("count before dismiss"), 7);
check("six after", val("count after dismiss"), 6);
check("seven again when undismissed", val("count after undismiss"), 7);

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  "\n✓ books review: six kinds fire, three false positives stay quiet, and the" +
    " one unknowable impact says so.",
);
