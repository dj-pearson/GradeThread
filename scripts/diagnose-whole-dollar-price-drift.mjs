// Count the Poshmark and Vinted rows priced in cents those marketplaces
// cannot hold (US-3318 AC1).
//
// WHY A DIAGNOSTIC BEFORE A REPAIR. 00806 is an UPDATE over live seller money.
// Its own WHERE clauses make it safe to run blind, but "safe" and "understood"
// are different things: the story asks for the count first, per platform, and
// specifically for how many rows sit BELOW the marketplace floor rather than
// merely carrying cents. A 32.49 that becomes 32.00 is a rounding repair. A
// 0.40 that becomes 1.00 is a price that could never have existed, and that
// is the number worth seeing before anything is written.
//
// IT IS A READ. There is no --apply and no write path in this file. The repair
// is supabase/migrations/00806_repair_whole_dollar_listing_prices.sql and the
// owner applies it.
//
// THE RULE IS NOT REIMPLEMENTED HERE. stepPriceCents from
// src/lib/marketplace-price.ts is imported and called, so the count this
// prints and the rows 00806 touches are decided by the same function the
// extension and the edge already use. If they ever disagree, this prints the
// wrong number rather than quietly agreeing with a copy of itself.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/diagnose-whole-dollar-price-drift.mjs

import { dollarsToCents, stepPriceCents } from "../src/lib/marketplace-price.ts";

/**
 * The platforms that price in whole dollars, and the step they price in.
 *
 * Kept as a literal rather than read from marketplace-specs.ts, because that
 * module pulls in the whole SPA type graph for a script that needs two
 * numbers. src/test/whole-dollar-price-repair.test.ts asserts this list still
 * equals every platform declaring priceStep in the registry, so it cannot
 * drift silently.
 */
export const WHOLE_DOLLAR = { poshmark: 1, vinted: 1 };

const PAGE = 1000;

export function blobPrice(row, field) {
  const variant = row.platform_fields?.[row.platform];
  if (!variant || typeof variant !== "object") return null;
  const raw = variant[field];
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** An empty tally, so a platform with no rows still prints as zero. */
export function emptyTally(platforms = Object.keys(WHOLE_DOLLAR)) {
  const t = {};
  for (const p of platforms) {
    t[p] = { rows: 0, columnDrift: 0, blobDrift: 0, belowFloor: 0, disagree: 0, worst: 0 };
  }
  return t;
}

/**
 * Fold one page of rows into the tally.
 *
 * Pure and exported so the counting can be driven against the SAME fixture
 * 00806 was proved on, rather than being trusted because it reads plausibly.
 * src/test/whole-dollar-price-repair.test.ts does exactly that.
 */
export function tallyRows(rows, tally, specs = WHOLE_DOLLAR) {
  for (const row of rows) {
    const step = specs[row.platform];
    if (!step) continue;
    const t = tally[row.platform];
    if (!t) continue;
    const stepCents = dollarsToCents(step);
    const cents = dollarsToCents(Number(row.listing_price));
    // A row with no price is "nothing set", not a rounding error. The query
    // filters these out; the guard is here too so the rule lives with the
    // counting rather than only in a URL.
    if (!(cents > 0)) continue;
    t.rows++;

    const want = stepPriceCents(cents, stepCents);
    if (cents !== want) {
      t.columnDrift++;
      // Below the floor is the group that is not a rounding error: the
      // marketplace has no such price, so the row records something that
      // could never have been listed.
      if (cents < stepCents) t.belowFloor++;
      const off = Math.abs(want - cents);
      if (off > t.worst) t.worst = off;
    }

    const blob = blobPrice(row, "price");
    if (blob !== null) {
      const bc = dollarsToCents(blob);
      if (bc > 0 && bc !== stepPriceCents(bc, stepCents)) t.blobDrift++;
      // A row whose two copies already disagree is worse than one that is
      // merely wrong, and 00806 fixes both in one statement set. Counting it
      // here says how much of that there is.
      if (bc !== cents) t.disagree++;
    }
  }
  return tally;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "[price-drift] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. " +
        "This is a read against prod; it writes nothing.",
    );
    process.exit(1);
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const platforms = Object.keys(WHOLE_DOLLAR);

  const tally = emptyTally(platforms);

  let from = 0;
  for (;;) {
    const res = await fetch(
      `${url}/rest/v1/listings` +
        `?select=id,platform,listing_price,platform_fields` +
        `&platform=in.(${platforms.join(",")})` +
        `&listing_price=gt.0&order=id.asc`,
      { headers: { ...headers, Range: `${from}-${from + PAGE - 1}` } },
    );
    if (!res.ok) {
      console.error(`[price-drift] read failed: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const rows = await res.json();
    if (rows.length === 0) break;
    tallyRows(rows, tally);
    if (rows.length < PAGE) break;
    from += PAGE;
  }

  console.log("[price-drift] Poshmark and Vinted rows priced in cents (US-3318)\n");
  let anyDrift = 0;
  for (const p of platforms) {
    const t = tally[p];
    anyDrift += t.columnDrift + t.blobDrift;
    console.log(`  ${p}`);
    console.log(`    rows with a price          ${t.rows}`);
    console.log(`    listing_price to repair    ${t.columnDrift}`);
    console.log(`      of those, below $${WHOLE_DOLLAR[p]} floor  ${t.belowFloor}`);
    console.log(`    platform_fields to repair  ${t.blobDrift}`);
    console.log(`    column and blob disagree   ${t.disagree}`);
    console.log(`    largest correction         ${(t.worst / 100).toFixed(2)} dollars`);
  }
  console.log(
    anyDrift === 0
      ? "\n  Nothing to repair. 00806 would report 0 rows."
      : `\n  ${anyDrift} row-level corrections. Apply 00806 and read its NOTICE back.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
