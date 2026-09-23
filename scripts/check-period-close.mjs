#!/usr/bin/env node
// US-2995 — period close, against a real Postgres.
//
// Ninth of the db-backed money checks, registered in the db lane with the rest.
//
// EVERY REFUSAL IS TESTED AS `postgres`, THE MOST PRIVILEGED ROLE THERE IS.
// That is the whole point of AC2 and the reason the guard is a trigger rather
// than an RLS policy: the edge service uses the service-role client, which
// BYPASSES RLS, and those are exactly the paths -- routes, jobs, webhooks --
// that would rewrite a filed year with nobody watching. A guard that only stops
// the browser stops nothing that matters.
//
// The NEGATIVE half matters as much: shipping, tracking and renaming still work
// inside a closed year. A buyer can open a return in February on a December
// sale, and refusing that write would break the marketplace sync rather than
// protect the books. A lock that blocks real work is a lock that gets switched
// off.

import { existsSync } from "node:fs";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "period-close.sql");

const psql = psqlTarget();

if (!existsSync(FIXTURE)) {
  console.error(`✗ fixture missing: ${FIXTURE}`);
  process.exit(1);
}

// BOTH STREAMS. psql sends RAISE NOTICE to STDERR, and every assertion in this
// fixture is a notice -- so a capture of stdout alone reports thirteen failures
// against a database that is behaving perfectly. It did, before this comment
// existed.
// US-3435: one home for the invocation, and it reads BOTH streams -- psql
// sends RAISE NOTICE to stderr and every assertion in this fixture is a
// notice, so a stdout-only capture reports failures against a database that
// is behaving perfectly.
const { ok: reached, out: raw } = runFixture(psql, FIXTURE, { args: ["-F", "|"] });
if (!reached) {
  console.error(`\u2717 could not reach ${psql.how}.\n  ${psql.hint}\n  ${raw.split("\n")[0]}`);
  process.exit(2);
}

const failures = [];
const notices = raw
  .split("\n")
  .filter((l) => l.includes("NOTICE:"))
  .map((l) => l.replace(/.*NOTICE:\s*/, "").trim());
const val = (q) =>
  raw.split("\n").find((l) => l.startsWith(`${q}|`))?.split("|")[1]?.trim();

function expectNotice(label, text) {
  const ok = notices.includes(text);
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
}
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got ${actual}, expected ${expected}`}`);
  if (!ok) failures.push(label);
}

// Any FAIL notice means the fixture itself observed the wrong behaviour.
const observed = notices.filter((n) => n.startsWith("FAIL:"));
if (observed.length > 0) {
  for (const f of observed) console.error(`  ✗ ${f}`);
  failures.push(...observed);
}

console.log("Closing a year (AC1, AC5):");
check("the close returns an id", val("closed period id"), "true");
// AC5: one action. A close that left the seller to remember a second step
// would produce closed years with no Part III figures.
check("it takes the inventory snapshot in the same action", val("snapshot taken by the close"), 1);
check("and records the figures as they stood", val("closing figures recorded"), "true");

// 00829. close_period is SECURITY DEFINER, so figures it computed through the
// RLS-scoped reconciliation functions covered every seller in the database.
// The fixture's second seller has a sale and stock in the same year; the
// first seller's figures must be their own: ledger net, dashboard net, sold
// item count, gross purchases.
check(
  "closing figures cover only the seller who closed (not a second seller's sale)",
  val("closing figures cover the caller only"),
  "5700,5700,1,5000",
);

// 00828. home_office_years has no lock trigger, so this is the input a
// rebuild could quietly move. The check halves it after the close.
console.log("\nA rebuild does not move a closed period (00828):");
check(
  "the closed year keeps its $1,000 home office after the source is halved",
  val("closed-year home office after rebuild"),
  -100000,
);
check(
  "and its ledger still equals closing_figures",
  val("closed-year ledger still matches closing_figures"),
  "true",
);
// 00829 computes the COGS block inline; for the seller themself it must be
// exactly what cogs_worksheet returns under RLS.
check(
  "the recorded COGS block equals cogs_worksheet for that seller",
  val("closing cogs equals cogs_worksheet for the seller"),
  "true",
);

console.log("\nTHE LOCK, ALL AS `postgres` (service-role privilege) — AC2:");
expectNotice("an expense in a closed year cannot be edited", "OK: expense edit refused");
expectNotice("nor deleted", "OK: expense delete refused");
expectNotice("nor can one be backdated into it", "OK: backdated insert refused");
expectNotice("a mileage trip cannot be edited", "OK: trip edit refused");
expectNotice("a sale's money cannot be edited", "OK: sale money edit refused");
expectNotice(
  "the cost of an item sold in a closed year cannot be edited",
  "OK: cost edit refused",
);

console.log("\nAND ORDINARY WORK STILL GOES THROUGH:");
expectNotice(
  "a closed-year sale can still be shipped",
  "OK: shipping a closed-year sale still works",
);
expectNotice("an item can still be renamed", "OK: renaming an item still works");
expectNotice("the open year is untouched", "OK: the open year is still editable");
expectNotice(
  "an unsold item's cost is still editable",
  "OK: an unsold item cost is still editable",
);

console.log("\nReopening (AC4):");
expectNotice("a blank reason is refused", "OK: a blank reason is refused");
expectNotice("a reason reopens it", "OK: reopened with a reason");
// The row is KEPT, not deleted: a period closed and reopened is a different
// fact from one never closed.
check("the audit row survives the reopen", val("audit row kept after reopen"), 1);
expectNotice("and writes work again", "OK: writes work again after reopening");
// The escape hatch for 00828: once reopened, the year rebuilds from source.
check(
  "and a rebuild after reopening picks up the halved home office",
  val("reopened-year home office after rebuild"),
  -50000,
);

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  "\n✓ period close: the lock holds against the service role, and ordinary work still goes through.",
);
