#!/usr/bin/env node
// US-2988 — the 1099-K bridge, against a real Postgres.
//
// Fourth of the database-backed checks, gated like the others: it needs
// Postgres, so it is not in `npm run verify`. A lane that skips silently when
// the stack is down teaches everyone to ignore it.
//
// THE ASSERTION THIS EXISTS FOR: computed gross is IDENTICAL on both US-2987
// tax branches. A 1099-K counts the buyer's payment, so it includes sales tax
// whether the marketplace collected it (excluded account) or the seller did
// (inside sales_revenue). If the bridge forgets to add the excluded account
// back, every marketplace seller's variance comes out equal to exactly their
// sales tax -- which looks like a real finding, sends them hunting for missing
// sales, and is entirely our bug.
//
// Usage:
//   node scripts/check-1099k-bridge.mjs [--container <name>]

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "form-1099k.sql");

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

// Three bridge objects come back, in fixture order.
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
        /* not a bridge object */
      }
      start = -1;
    }
  }
}

if (objects.length < 3) {
  console.error(
    `✗ expected three bridges, parsed ${objects.length}. Raw tail:\n${raw.slice(-900)}`,
  );
  process.exit(1);
}

const [ebay26, shopify26, ebay27] = objects;
const money = (c) => `$${((c ?? 0) / 100).toFixed(2)}`;
const failures = [];

function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  got ${actual}, expected ${expected}`}`);
  if (!ok) failures.push(label);
}

console.log("Gross is the buyer's payment: price + shipping + tax");
check("eBay 2026 gross is $118.24", ebay26.computed_gross_cents, 11824);
check("Shopify 2026 gross is $118.24", shopify26.computed_gross_cents, 11824);

console.log("\nTHE ONE THIS CHECK EXISTS FOR:");
const sameGross =
  ebay26.computed_gross_cents === shopify26.computed_gross_cents;
console.log(
  `  ${sameGross ? "✓" : "✗"} identical sales on opposite tax branches compute the` +
    ` SAME gross (${money(ebay26.computed_gross_cents)} vs ${money(shopify26.computed_gross_cents)})`,
);
if (!sameGross) failures.push("gross differed between tax branches");
check("eBay booked the tax as excluded", ebay26.facilitator_tax_cents, 825);
check("Shopify booked it as remitted instead", shopify26.remitted_tax_cents, -825);
check("and profit lands identically too", ebay26.profit_before_overheads_cents,
  shopify26.profit_before_overheads_cents);

console.log("\nThe form, and the variance:");
check("the form is found", ebay26.form_present, true);
check("reported gross is $123.24", ebay26.reported_gross_cents, 12324);
check("the variance is $5.00", ebay26.variance_cents, 500);
check("the payer's TIN is four digits", ebay26.payer_tin_last4, "4821");
check("a platform with no form reports no variance", shopify26.variance_cents, 0);
check("and says so rather than implying a zero", shopify26.form_present, false);

console.log("\nA 1099-K is a CALENDAR year, whatever the seller's fiscal year:");
check("2026 covers Jan 1 to Jan 1", `${ebay26.from} ${ebay26.to}`, "2026-01-01 2027-01-01");
check("the Dec 28 sale is in 2026", ebay26.sale_count, 1);
check("the Jan 3 sale is in 2027, not 2026", ebay27.sale_count, 1);
check("and it carries its own gross", ebay27.computed_gross_cents, 54125);

console.log("\nWhat must NOT be in there:");
// The cancelled sale was $900 + $74.25 tax. If it leaked in, gross would be
// nearer $1,092 than $118.
check("a cancelled sale is not in the gross", ebay26.computed_gross_cents, 11824);
check("nor in the count", ebay26.sale_count, 1);
check(
  "another platform's sales stay out",
  ebay26.computed_gross_cents === shopify26.computed_gross_cents &&
    ebay26.facilitator_tax_cents !== shopify26.facilitator_tax_cents,
  true,
);

console.log(
  `\nBridge: reported ${money(ebay26.reported_gross_cents)} -> computed ` +
    `${money(ebay26.computed_gross_cents)} -> profit ` +
    `${money(ebay26.profit_before_overheads_cents)} before overheads.`,
);

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\n✓ 1099-K bridge: gross is branch-independent and the year is a calendar year.");
