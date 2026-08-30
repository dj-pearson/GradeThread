#!/usr/bin/env node
// US-2998 — what is due to push to QuickBooks, against a real Postgres.
//
// Tenth of the db-backed money checks, and it runs in the db lane with the
// others rather than carrying an exemption.
//
// THE ASSERTION THIS EXISTS FOR IS THE GROUPING. Everything else about the
// push is covered by unit tests against a mock; the one thing a mock cannot
// tell you is whether the SQL that decides what a document IS puts a sale's
// five ledger entries into one document or five. Five would appear in
// QuickBooks as five unrelated receipts for the same jacket, and no test that
// mocks the database would notice.
//
// It also proves the tenant guard fires. qbo_pending_documents is SECURITY
// DEFINER, so the only thing standing between a signed-in seller and another
// tenant's books is the 42501 it raises in its own body.
//
// psql writes RAISE NOTICE to STDERR, so this uses spawnSync and reads BOTH
// streams. An earlier check in this epic used execFileSync, captured stdout
// only, and reported thirteen failures against a database that was behaving
// perfectly.
//
// Usage:
//   node scripts/check-qbo-sync.mjs [--container <name>]

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "qbo-sync.sql");

const args = process.argv.slice(2);
const at = args.indexOf("--container");
const container = at >= 0 ? args[at + 1] : "supabase_db_gradethread";

if (!existsSync(FIXTURE)) {
  console.error(`✗ fixture missing: ${FIXTURE}`);
  process.exit(1);
}

const run = spawnSync(
  "docker",
  ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-F", "|"],
  { input: readFileSync(FIXTURE, "utf8"), encoding: "utf8" },
);

if (run.error || run.status === null) {
  console.error(
    `✗ could not reach Postgres in container "${container}".\n` +
      `  Start it with: docker start ${container}\n` +
      `  ${run.error?.message ?? "no exit status"}`,
  );
  process.exit(2);
}

const raw = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

let documents = null;
{
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      documents = JSON.parse(raw.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
}
if (!Array.isArray(documents)) {
  console.error(`✗ could not parse the documents. Raw tail:\n${raw.slice(-1200)}`);
  process.exit(1);
}

const failures = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got ${actual}, expected ${expected}`}`);
  if (!ok) failures.push(label);
}
const val = (q) => lines.find((l) => l.startsWith(`${q}|`))?.split("|")[1];
const notice = (tag) =>
  lines.find((l) => l.includes(`${tag}|`))?.split(`${tag}|`)[1]?.trim();
const of = (kind) => documents.filter((d) => d.object_kind === kind);

console.log("One sale is ONE document, not five:");
check("exactly three documents", documents.length, 3);
check("one sales receipt", of("sales_receipt").length, 1);
check("one purchase", of("purchase").length, 1);
check("one deposit", of("deposit").length, 1);

const sale = of("sales_receipt")[0];
const codes = (sale?.lines ?? []).map((l) => l.account_code).sort();
console.log("\nAnd it carries every part of the sale:");
check(
  "revenue, shipping, fees, label, grading and cost of goods",
  JSON.stringify(codes),
  JSON.stringify([
    "cogs_other",
    "platform_fees",
    "purchases",
    "sales_revenue",
    "shipping_income",
    "shipping_postage",
  ]),
);
// AC4: the cost of the item is on the SALE. If it were pushed at purchase time,
// gross profit in QuickBooks would move a month before gross profit here.
check(
  "cost of goods rides on the sale",
  (sale?.lines ?? []).some((l) => l.account_code === "purchases" && l.amount_cents === -4200),
  true,
);

console.log("\nFacilitator tax is out of the total and reported beside it:");
// 18000 + 1299 - 2862 - 985 - 300 - 4200 = 10952. The tax is not in it.
check("total excludes the tax", sale?.total_cents, 10952);
check("the tax is still reported", sale?.excluded_tax_cents, 1487);
check(
  "and it is NOT a line",
  (sale?.lines ?? []).some((l) => l.account_code === "sales_tax_collected"),
  false,
);

console.log("\nThe payout names its sales by reference, not by amount:");
check("one sale on this payout", val("payout sales"), 1);
check(
  "and it is the RIGHT seller's sale",
  val("payout sale id"),
  "c0000000-0000-0000-0000-0000000ab001",
);

console.log("\nBounded and resumable (AC7):");
check("a cursor skips what is behind it", val("after cursor"), 1);
check("a limit is a limit", val("limit respected"), 1);

console.log("\nThe tenant guard fires rather than answering:");
check("another tenant's documents are refused", notice("GUARD"), "refused");
check("another tenant's payout is refused", notice("PAYOUT_GUARD"), "refused");

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  "\n✓ qbo sync: one sale is one document, the tax is split out rather than" +
    " booked, the payout link is real, and another tenant gets 42501.",
);
