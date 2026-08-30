#!/usr/bin/env node
// US-2987 — the two sales-tax branches, against a real Postgres.
//
// Third of the database-backed checks, alongside check-ledger-invariant and
// check-cogs-worksheet, and gated the same way: it needs Postgres, so it is not
// in `npm run verify`. A lane that skips silently when the stack is down
// teaches everyone to ignore it.
//
// WHY THIS ONE CANNOT BE EYEBALLED. Net profit is IDENTICAL on both branches:
// facilitator tax is excluded outright, and seller-collected tax is booked as
// income and as an equal deduction. So the bottom line cannot tell you the
// branch was chosen correctly. Gross receipts can — and gross receipts is the
// figure a 1099-K is compared against, which is the whole point of US-2988.
//
// Usage:
//   node scripts/check-facilitator-tax.mjs [--container <name>]

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "facilitator-tax.sql");

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

const rows = raw
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => l.split("|"));

const failures = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got ${actual}, expected ${expected}`}`);
  if (!ok) failures.push(label);
}

// ── the rule, asked directly ───────────────────────────────────────────────
const rule = (q) => rows.find((r) => r[0] === q)?.[1];

console.log("The facilitator rule:");
check("eBay is a facilitator in 2026", rule("ebay 2026"), "t");
check("Shopify is NOT", rule("shopify 2026"), "f");
check("an unknown channel is NOT (the conservative answer)", rule("other 2026"), "f");
check(
  "eBay in 2019 is NOT, because the rule has an effective date",
  rule("ebay 2019 (before the rule)"),
  "f",
);

// ── where the tax landed ───────────────────────────────────────────────────
// platform | code | schedule_c_line | amount_cents | source_detail
const taxRows = rows.filter((r) => r.length === 5 && /^tax/.test(r[4]));
const has = (platform, code, line, cents) =>
  taxRows.some(
    (r) =>
      r[0] === platform &&
      r[1] === code &&
      r[2] === line &&
      r[3] === String(cents),
  );

console.log("\nWhere the tax landed:");
check(
  "eBay tax is excluded and reaches no line",
  has("ebay", "sales_tax_collected", "", 825),
  true,
);
check(
  "Shopify tax is in gross receipts, line 1",
  has("shopify", "sales_revenue", "1", 825),
  true,
);
check(
  "Shopify remittance is a deduction, line 23",
  has("shopify", "sales_tax_remitted", "23", -825),
  true,
);
check(
  "a sale whose listing is gone takes the conservative branch",
  has("no listing", "sales_revenue", "1", 825),
  true,
);
check(
  "eBay produces no remittance entry",
  taxRows.some((r) => r[0] === "ebay" && r[1] === "sales_tax_remitted"),
  false,
);

// ── the figure that tells the branches apart ───────────────────────────────
// platform | gross_receipts | excluded | net
const totals = rows.filter(
  (r) => r.length === 4 && ["ebay", "shopify", "no listing"].includes(r[0]),
);
const grossFor = (p) => totals.find((r) => r[0] === p)?.[1];
const netFor = (p) => totals.find((r) => r[0] === p)?.[3];

console.log("\nGross receipts, which is what a 1099-K is compared against:");
check("eBay gross is the sale price alone", grossFor("ebay"), "10000");
check("Shopify gross includes the tax", grossFor("shopify"), "10825");
check("no-listing gross includes the tax", grossFor("no listing"), "10825");

console.log("\nAnd the trap this check exists for:");
const nets = ["ebay", "shopify", "no listing"].map(netFor);
const allSame = nets.every((n) => n === nets[0]);
console.log(
  `  ${allSame ? "✓" : "✗"} net profit is identical on every branch (${nets.join(", ")})` +
    ` — so the bottom line proves nothing here`,
);
if (!allSame) failures.push("net profit differed between branches");

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\n✓ facilitator tax: both branches book to the right lines.");
