#!/usr/bin/env node
// US-3318 / migration 00806 -- run the whole-dollar repair against real rows.
//
// 00806 is the one HELD migration that rewrites seller data. Its header states
// six worked examples and a guarantee that listing_price and platform_fields
// move together; this executes both against a Postgres carrying the migrations,
// so the apply is a measurement rather than an argument.
//
// It also proves the three rows that must NOT move: eBay and Depop are not
// whole-dollar marketplaces, and a zero price is "no price set".
//
// Usage:
//   node scripts/check-whole-dollar-price-repair.mjs --dsn "postgresql://..."
//   node scripts/check-whole-dollar-price-repair.mjs            # docker container
//
// Writes nothing: the fixture runs inside a transaction that rolls back.

import { join } from "node:path";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";

const HERE = import.meta.dirname;
const target = psqlTarget();
const { ok, out } = runFixture(
  target,
  join(HERE, "fixtures", "whole-dollar-price-repair.sql"),
  {
    includes: {
      "-- @@MIGRATION_00806@@": join(
        HERE,
        "..",
        "supabase/migrations/00806_repair_whole_dollar_listing_prices.sql",
      ),
    },
  },
);
if (!ok) {
  console.error(`✗ could not reach ${target.how}.\n  ${target.hint}\n  ${out.split("\n")[0]}`);
  process.exit(2);
}

const line = out.split("\n").find((l) => l.trim().startsWith('{"rows"'));
if (!line) {
  console.error("✗ the fixture printed no result object. Raw tail:\n" + out.slice(-1200));
  process.exit(1);
}
const rows = JSON.parse(line).rows;

/** What 00806's own header says each row becomes. */
const EXPECTED = [
  { platform: "poshmark", price: "32.00", blob: "32.00", why: "32.49 rounds down to nearest" },
  { platform: "poshmark", price: "33.00", blob: "33.00", why: "32.50 rounds up at the boundary" },
  { platform: "vinted", price: "32.00", blob: "32.00", override: "32.00", why: "31.50 rounds up, and the override is stepped too" },
  { platform: "vinted", price: "1.00", blob: "1.00", why: "0.40 is below the floor, never $0" },
  { platform: "poshmark", price: "1.00", blob: "1.00", other_key: "keep me", why: "0.01 floors, and the rest of the blob survives" },
  { platform: "poshmark", price: "25.00", blob: "25.00", why: "already whole, untouched" },
  { platform: "ebay", price: "32.49", blob: "32.49", why: "eBay prices in cents and must not move" },
  { platform: "depop", price: "32.49", blob: "32.49", why: "Depop's absence from the list is deliberate" },
  { platform: "poshmark", price: "0.00", blob: "0", why: "zero is no price set, not a rounding error" },
];

if (rows.length !== EXPECTED.length) {
  console.error(`✗ expected ${EXPECTED.length} rows, got ${rows.length}`);
  process.exit(1);
}

const problems = [];
rows.forEach((r, i) => {
  const e = EXPECTED[i];
  const bad = [];
  if (r.platform !== e.platform) bad.push(`platform ${r.platform} != ${e.platform}`);
  if (r.price !== e.price) bad.push(`listing_price ${r.price} != ${e.price}`);
  if (r.blob !== e.blob) bad.push(`platform_fields price ${r.blob} != ${e.blob}`);
  if ("override" in e && r.override !== e.override) {
    bad.push(`price_override ${r.override} != ${e.override}`);
  }
  if ("other_key" in e && r.other_key !== e.other_key) {
    bad.push(`the rest of the channel blob was lost (title ${r.other_key})`);
  }
  const mark = bad.length === 0 ? "ok  " : "FAIL";
  console.log(`  ${mark} ${e.platform.padEnd(9)} ${r.price.padStart(6)}  ${e.why}`);
  if (bad.length > 0) problems.push(`${e.platform} row ${i + 1}: ${bad.join("; ")}`);
});

if (problems.length > 0) {
  for (const p of problems) console.error(`\n✗ ${p}`);
  console.error(
    "\nlisting_price and platform_fields must move TOGETHER. The composer reads " +
      "the blob and reconciliation reads the column, so a half repair makes them " +
      "contradict each other as well as the marketplace.",
  );
  process.exit(1);
}

console.log(
  "\n✓ 00806: six worked examples land where its header says, the column and " +
    "the blob agree, and eBay, Depop and a zero price are untouched.",
);
