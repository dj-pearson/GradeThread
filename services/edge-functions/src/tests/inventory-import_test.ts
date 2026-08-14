import { assert, assertEquals } from "@std/assert";
import {
  FILL_ITEM_FIELDS,
  fillPatch,
  isBlank,
  MAX_IMPORT_ROWS,
  MAX_RUN_ATTEMPTS,
  normalizeImportRows,
  RUN_STALE_MS,
} from "../lib/inventory-import.ts";

// US-2518. The CSV import used to run in the browser under a "Don't close this
// tab" banner and could not be undone. The rows now travel to a durable worker,
// which means the server — not the page — decides what an import may write.

Deno.test("normalizeImportRows drops a row with no title", () => {
  const rows = normalizeImportRows([
    { title: "Levi's 501", sku: "A1" },
    { sku: "A2" },
    { title: "   ", sku: "A3" },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.sku, "A1");
});

Deno.test("normalizeImportRows keeps only fields an import may write", () => {
  const rows = normalizeImportRows([
    {
      title: "Jacket",
      // A client that tries to choose its own tenant, or to write a column no
      // import owns, must not be able to.
      user_id: "00000000-0000-0000-0000-000000000000",
      id: "11111111-1111-1111-1111-111111111111",
      acquired_price: 12.5,
      grade: 9.5,
    },
  ]);
  const row = rows[0]! as unknown as Record<string, unknown>;
  assert(!("user_id" in row), "user_id must never survive normalization");
  assert(!("id" in row), "id must never survive normalization");
  assert(!("grade" in row), "an import cannot write a grade");
  assertEquals(rows[0]!.acquired_price, 12.5);
});

Deno.test("normalizeImportRows refuses an unknown enum value", () => {
  const rows = normalizeImportRows([
    { title: "A", status: "definitely-not-a-status", item_category: "nope" },
    { title: "B", status: "LISTED", item_category: "Shoes" },
  ]);
  assertEquals(rows[0]!.status, null);
  assertEquals(rows[0]!.item_category, null);
  // Case is normalized, since a sheet writes "Listed" and "Shoes".
  assertEquals(rows[1]!.status, "listed");
  assertEquals(rows[1]!.item_category, "shoes");
});

Deno.test("normalizeImportRows only accepts an ISO date", () => {
  // The browser parses the seller's date formats (including the year-less "1/25"
  // trap fixed in parseDate). By the time a row reaches here it is ISO or it is
  // nothing — a half-parsed date is worse than a blank one.
  const rows = normalizeImportRows([
    { title: "A", acquired_date: "2026-03-04" },
    { title: "B", acquired_date: "3/4/26" },
    { title: "C", acquired_date: "not a date" },
  ]);
  assertEquals(rows[0]!.acquired_date, "2026-03-04");
  assertEquals(rows[1]!.acquired_date, null);
  assertEquals(rows[2]!.acquired_date, null);
});

Deno.test("a listing or sale with nothing in it is not created", () => {
  const rows = normalizeImportRows([
    { title: "A", listing: {}, sale: {} },
    { title: "B", listing: { listing_price: 40 }, sale: { sale_price: 55 } },
  ]);
  assertEquals(rows[0]!.listing, null);
  assertEquals(rows[0]!.sale, null);
  assertEquals(rows[1]!.listing?.listing_price, 40);
  assertEquals(rows[1]!.sale?.sale_price, 55);
});

Deno.test("row numbers survive, so the error list points at the right line", () => {
  const rows = normalizeImportRows([
    { title: "A", row: 7 },
    { title: "B" },
  ]);
  assertEquals(rows[0]!.row, 7);
  // Defaults to the file line: row 1 is the header.
  assertEquals(rows[1]!.row, 3);
});

Deno.test("fillPatch writes a blank column and never overwrites a full one", () => {
  const existing = {
    id: "x",
    title: "Existing title",
    brand: null,
    size: "   ",
    status: "listed",
  };
  const patch = fillPatch(existing, {
    title: "Incoming title",
    brand: "Levi's",
    size: "M",
    status: "sourced",
  });
  // The populated ones are untouched — this is the US-1082 fill-only rule, and
  // it is what makes a re-import safe.
  assert(!("title" in patch), "a populated title must not be overwritten");
  assert(!("status" in patch), "a populated status must not be overwritten");
  assertEquals(patch.brand, "Levi's");
  // Whitespace counts as blank.
  assertEquals(patch.size, "M");
});

Deno.test("fillPatch never writes a GradeThread-owned column", () => {
  // sku is the match key; source_id, condition_notes, acquired_price and
  // acquired_date are owned elsewhere (sync-source-of-truth.md). A CSV must not
  // reach them on a re-import, only on the initial insert.
  for (const banned of [
    "sku",
    "source_id",
    "condition_notes",
    "acquired_price",
    "acquired_date",
  ]) {
    assert(
      !(FILL_ITEM_FIELDS as readonly string[]).includes(banned),
      `${banned} must not be fillable by a re-import`,
    );
  }
});

Deno.test("isBlank treats whitespace as empty", () => {
  assertEquals(isBlank(null), true);
  assertEquals(isBlank(undefined), true);
  assertEquals(isBlank("  \t "), true);
  assertEquals(isBlank(0), false);
  assertEquals(isBlank("x"), false);
});

Deno.test("the durable-job constants keep their ordering", () => {
  // A live run must never look stale to the reclaim sweep, and an attempt cap is
  // what stops a reclaim loop running for ever (durable-jobs contract).
  assert(RUN_STALE_MS >= 5 * 60 * 1000, "stale window is too tight");
  assertEquals(MAX_RUN_ATTEMPTS, 5);
  assert(MAX_IMPORT_ROWS > 0 && MAX_IMPORT_ROWS <= 20000);
});
