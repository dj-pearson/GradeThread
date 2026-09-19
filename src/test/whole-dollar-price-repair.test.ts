import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dollarsToCents, stepPriceCents } from "@/lib/marketplace-price";
import { MARKETPLACE_SPECS } from "@/lib/marketplace-specs";
// @ts-expect-error - a plain .mjs operator script with no types of its own.
import { WHOLE_DOLLAR, emptyTally, tallyRows } from "../../scripts/diagnose-whole-dollar-price-drift.mjs";

// US-3318: Poshmark and Vinted rows already written with cents those
// marketplaces cannot hold.
//
// THE THING WORTH PINNING is that three places agree about one rule: the
// repair migration's SQL, the diagnostic that counts what it will touch, and
// stepPriceCents, which is what the extension actually types into the form.
// A repair that rounds differently from the code is a repair that has to be
// done again.
//
// The fixture below is the SAME set of rows the migration was proved on
// against a local Postgres 16, and the expected values are what that run
// produced. So this file is not a second opinion about the arithmetic; it is
// the record of a measurement, and it fails if the JS side drifts from it.

const MIGRATION = resolve(__dirname, "../../supabase/migrations/00806_repair_whole_dollar_listing_prices.sql");
const SQL = readFileSync(MIGRATION, "utf8");

/** stored dollars -> the dollars the repair produced, measured on Postgres 16. */
const MEASURED: [number, number, string][] = [
  [32.49, 32, "nearest, rounds down"],
  [32.50, 33, "nearest, .5 rounds up"],
  [31.50, 32, "nearest, .5 rounds up"],
  [0.40, 1, "below the floor, never $0"],
  [0.01, 1, "below the floor"],
  [25.00, 25, "already whole, untouched"],
];

describe("the whole-dollar repair rounds the way the extension types (US-3318)", () => {
  it("stepPriceCents agrees with what the migration did on a real Postgres", () => {
    for (const [stored, expected, why] of MEASURED) {
      const got = stepPriceCents(dollarsToCents(stored), dollarsToCents(1)) / 100;
      expect(got, `${stored} -> ${expected} (${why})`).toBe(expected);
    }
  });

  it("the migration's own worked-example table says the same thing", () => {
    // The table is a comment, which is exactly the kind of thing that rots.
    // Reading it back means a future edit that changes the SQL without
    // changing the table, or the other way round, reddens here.
    for (const [stored, expected] of MEASURED) {
      const cents = Math.round(stored * 100);
      const row = new RegExp(
        `^--\\s+${stored.toFixed(2)}\\s+${cents}\\s+${expected * 100}\\s+${expected.toFixed(2)}\\b`,
        "m",
      );
      expect(SQL, `no worked-example row for ${stored}`).toMatch(row);
    }
  });

  it("nearest, not floored, because flooring costs the seller money every time", () => {
    // The single most likely wrong version of this migration, and the one
    // whose damage is invisible: every repaired row would lose up to 99c.
    expect(SQL).toMatch(/round\(round\(listing_price \* 100\) \/ 100\.0\) \* 100/);
    expect(SQL).not.toMatch(/\bfloor\(/);
    expect(SQL).not.toMatch(/\btrunc\(/);
  });

  it("never below one step, so a 40-cent row cannot repair to zero", () => {
    // SCOPED TO EACH STATEMENT, and that is not pedantry. The first version
    // of this case asserted `greatest(100,` appeared ANYWHERE in the file.
    // Deleting it from the listing_price path alone left the blob's copy
    // matching, so the guard stayed green while a 0.40 row repaired to 0.00
    // on a real Postgres. Measured, then fixed.
    const column = SQL.slice(SQL.indexOf("-- 1. The column."), SQL.indexOf("-- 2. The blob"));
    const blob = SQL.slice(SQL.indexOf("-- 2. The blob"), SQL.indexOf("get diagnostics blob_rows"));
    expect(column, "the listing_price path lost its floor").toMatch(/greatest\(100,/);
    expect(blob.match(/greatest\(100,/g) ?? [], "the blob path lost a floor")
      .toHaveLength(2); // price and price_override
    expect(stepPriceCents(40, 100)).toBe(100);
    expect(stepPriceCents(1, 100)).toBe(100);
  });

  it("the column and the blob move together, in one statement set", () => {
    // A row whose two copies disagree is worse than one that is merely wrong:
    // the composer reads the blob and reconciliation reads the column.
    expect(SQL).toMatch(/set listing_price =/);
    expect(SQL).toMatch(/set platform_fields = jsonb_set\(/);
    expect(SQL.indexOf("do $$")).toBeLessThan(SQL.indexOf("set listing_price ="));
    expect(SQL.indexOf("set platform_fields")).toBeLessThan(SQL.indexOf("end $$"));
  });

  it("it reports how many rows it touched rather than succeeding silently", () => {
    expect(SQL).toMatch(/get diagnostics price_rows = row_count/);
    expect(SQL).toMatch(/get diagnostics blob_rows = row_count/);
    expect(SQL).toMatch(/raise notice/);
  });

  it("only the platforms that declare priceStep are touched", () => {
    // The registry is the authority. Depop's absence is deliberate and
    // explained there; mercari, grailed and facebook are unconfirmed against
    // a live form, and guessing one is the mistake this story's notes record.
    const declared = Object.entries(MARKETPLACE_SPECS)
      .filter(([, spec]) => typeof spec.priceStep === "number" && spec.priceStep > 0)
      .map(([platform]) => platform)
      .sort();
    expect(declared).toEqual(["poshmark", "vinted"]);
    expect(Object.keys(WHOLE_DOLLAR).sort()).toEqual(declared);
    expect(SQL).toMatch(/platform in \('poshmark', 'vinted'\)/);
    for (const other of ["mercari", "grailed", "facebook", "depop", "ebay"]) {
      expect(SQL, `${other} must not be in the repair`).not.toContain(`'${other}'`);
    }
  });

  it("the diagnostic counts the same rows the migration repaired", () => {
    // The fixture that ran against Postgres, verbatim. The migration reported
    // 4 listing_price rows and 4 platform_fields rows; the two below-floor
    // and cross-platform cases are what make those numbers non-obvious.
    const rows = [
      { platform: "poshmark", listing_price: 32.49, platform_fields: { poshmark: { price: 32.49, title: "keep me" } } },
      { platform: "poshmark", listing_price: 32.50, platform_fields: { poshmark: { price: 32.50 } } },
      { platform: "vinted", listing_price: 31.50, platform_fields: { vinted: { price: 31.50, price_override: 24.99 } } },
      { platform: "poshmark", listing_price: 0.40, platform_fields: { poshmark: { price: 0.40 } } },
      { platform: "vinted", listing_price: 25.00, platform_fields: { vinted: { price: 25.00 } } },
      { platform: "mercari", listing_price: 40.49, platform_fields: { mercari: { price: 40.49 } } },
      { platform: "poshmark", listing_price: 0.00, platform_fields: {} },
      { platform: "depop", listing_price: 19.99, platform_fields: { depop: { price: 19.99 } } },
    ];
    const t = tallyRows(rows, emptyTally());
    expect(t.poshmark.columnDrift + t.vinted.columnDrift).toBe(4);
    expect(t.poshmark.blobDrift + t.vinted.blobDrift).toBe(4);
    // Only the 40-cent row is below the floor. That is the group the story
    // singles out, because it is a price the marketplace could never hold.
    expect(t.poshmark.belowFloor).toBe(1);
    expect(t.vinted.belowFloor).toBe(0);
    // Five, not six: mercari and depop carry cents and are deliberately not
    // counted, and the $0.00 poshmark row is "no price set" rather than a
    // rounding error. Writing 6 here first is what proved the exclusion.
    expect(t.poshmark.rows + t.vinted.rows).toBe(5);
    // 60c, not the 50c a reader expects from the .5 rows: the largest move
    // is the FLOOR case, 0.40 -> 1.00. That is the point of counting it
    // separately, and writing 50 here first is what made it obvious.
    expect(t.poshmark.worst).toBe(60);
    expect(t.vinted.worst).toBe(50);
  });
});
