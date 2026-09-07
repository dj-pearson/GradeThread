// US-3132/US-3133: the supply index arithmetic. supply-sampling.ts imports only
// condition-item-key.ts, which depends on nothing, so there is no env to fake
// and no dynamic import needed here.
import { assertEquals } from "@std/assert";

import {
  type CellSeed,
  expandCells,
  HEADROOM_FRACTION,
  medianAskCents,
  MIN_PRICE_SAMPLE,
  NO_SNAPSHOT_BATCH,
  passSizeFromHeadroom,
} from "../lib/supply-sampling.ts";
import { normalizeItemKey } from "../lib/condition-item-key.ts";

// ── expandCells ────────────────────────────────────────────────────────────

Deno.test("expandCells: N brands by M terms produces N*M cells", () => {
  const brands = ["Carhartt", "Patagonia", "Levi's"];
  const terms = ["jacket", "jeans", "hoodie", "t-shirt"];
  const seeds: CellSeed[] = brands.flatMap((b) =>
    terms.map((t) => ({
      brandKey: b.toLowerCase().replace(/[^a-z]/g, ""),
      brandDisplay: b,
      categoryId: "11450",
      queryTerms: t,
    }))
  );
  assertEquals(expandCells(seeds).length, 12);
});

Deno.test("expandCells: a duplicate seed collapses rather than making two rows", () => {
  const seed: CellSeed = {
    brandKey: "carhartt",
    brandDisplay: "Carhartt",
    categoryId: "11450",
    queryTerms: "jacket",
  };
  // Same cell, spelled differently by the seeder: normalizeItemKey lowercases
  // and trims, so these are one market, not two.
  const shouty: CellSeed = { ...seed, brandDisplay: "  CARHARTT " };
  const cells = expandCells([seed, shouty]);
  assertEquals(cells.length, 1);
});

Deno.test("expandCells: the key is normalizeItemKey's, so a supply row joins the comp tables", () => {
  const [cell] = expandCells([{
    brandKey: "patagonia",
    brandDisplay: "Patagonia",
    categoryId: "11450",
    queryTerms: "Better Sweater",
  }]);
  // This is the exact call condition-index.ts makes for its seed of the same
  // name. If these two ever disagree the index cannot join to the curves.
  assertEquals(
    cell!.cellKey,
    normalizeItemKey({ categoryId: "11450", brand: "Patagonia", q: "Better Sweater" }),
  );
});

Deno.test("expandCells: marketplace is a column, not part of the key", () => {
  const cells = expandCells([
    { brandDisplay: "Nike", categoryId: "11450", queryTerms: "tee", marketplace: "ebay" },
  ]);
  assertEquals(cells[0]!.cellKey.includes("ebay"), false);
  assertEquals(cells[0]!.marketplace, "ebay");
});

Deno.test("expandCells: a category-only cell keeps a null brand", () => {
  const [cell] = expandCells([{ categoryId: "11450", queryTerms: "vintage denim jacket" }]);
  assertEquals(cell!.brandKey, null);
  assertEquals(cell!.brandDisplay, null);
  assertEquals(cell!.queryTerms, "vintage denim jacket");
});

Deno.test("expandCells: a seed with no category is dropped, not sampled unscoped", () => {
  // eBay refuses an aspect_filter with no category scope, so a brand cell
  // without one silently degrades into a keyword search. Better no cell.
  assertEquals(expandCells([{ brandDisplay: "Nike", categoryId: "  " }]).length, 0);
});

// ── medianAskCents ─────────────────────────────────────────────────────────

Deno.test("medianAskCents: below MIN_PRICE_SAMPLE returns null and the real count", () => {
  const thin = Array.from({ length: MIN_PRICE_SAMPLE - 1 }, (_, i) => (i + 1) * 1000);
  const r = medianAskCents(thin);
  assertEquals(r.median, null);
  assertEquals(r.sampleSize, MIN_PRICE_SAMPLE - 1);
});

Deno.test("medianAskCents: exactly MIN_PRICE_SAMPLE is enough", () => {
  const r = medianAskCents([1000, 2000, 3000, 4000, 5000]);
  assertEquals(r.median, 3000);
  assertEquals(r.sampleSize, 5);
});

Deno.test("medianAskCents: an even sample averages the middle pair", () => {
  const r = medianAskCents([1000, 2000, 3000, 4000, 5000, 6000]);
  assertEquals(r.median, 3500);
});

Deno.test("medianAskCents: junk prices are dropped before the count is taken", () => {
  // Five entries in, but two are not prices. The sample is three, so the
  // median must be null rather than a median of the three survivors.
  const r = medianAskCents([1000, 0, 2000, Number.NaN, 3000]);
  assertEquals(r.median, null);
  assertEquals(r.sampleSize, 3);
});

// ── passSizeFromHeadroom ───────────────────────────────────────────────────

Deno.test("passSizeFromHeadroom: ample allowance runs every cell", () => {
  const r = passSizeFromHeadroom({ remaining: 5000 }, 204);
  assertEquals(r.cells, 204);
  assertEquals(r.basis, "all_cells");
});

Deno.test("passSizeFromHeadroom: a tight allowance takes its fraction and says so", () => {
  // 400 remaining at a quarter share is 100 calls, short of 204 cells.
  const r = passSizeFromHeadroom({ remaining: 400 }, 204);
  assertEquals(r.cells, Math.floor(400 * HEADROOM_FRACTION));
  assertEquals(r.basis, "headroom");
});

Deno.test("passSizeFromHeadroom: no snapshot runs the conservative batch, not the full list", () => {
  const r = passSizeFromHeadroom(null, 204);
  assertEquals(r.cells, NO_SNAPSHOT_BATCH);
  assertEquals(r.basis, "no_snapshot");
});

Deno.test("passSizeFromHeadroom: a snapshot with a null remaining is the same as none", () => {
  const r = passSizeFromHeadroom({ remaining: null }, 204);
  assertEquals(r.basis, "no_snapshot");
});

Deno.test("passSizeFromHeadroom: an exhausted allowance yields zero, never a negative", () => {
  const r = passSizeFromHeadroom({ remaining: 0 }, 204);
  assertEquals(r.cells, 0);
  assertEquals(r.basis, "headroom");
});

Deno.test("passSizeFromHeadroom: the no-snapshot batch never exceeds the cell count", () => {
  const r = passSizeFromHeadroom(null, 3);
  assertEquals(r.cells, 3);
});

Deno.test("passSizeFromHeadroom: an empty cell list is zero, whatever the allowance", () => {
  assertEquals(passSizeFromHeadroom({ remaining: 9999 }, 0).cells, 0);
});
