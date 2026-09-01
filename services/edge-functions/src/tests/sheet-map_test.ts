// "Bring your own sheet" column-map engine — pure logic tests.
import { assert, assertEquals } from "@std/assert";
import {
  buildCreateFromSheet,
  formatMappedValue,
  formatSheetDate,
  mappedPushCells,
  mergeMappedRow,
  normalizeSheetMap,
  parseCurrency,
  parseMappedValue,
  parseSheetDate,
  planUnmatchedSkus,
  resolveMappedColumns,
  type ResolvedMappedColumn,
  type SheetMap,
  type SheetMapColumn,
  suggestFieldForHeader,
  validateSheetMap,
} from "../lib/sheet-map.ts";

const col = (over: Partial<SheetMapColumn>): SheetMapColumn => ({
  header: "X",
  field: "x",
  table: "inventory_items",
  ...over,
});

Deno.test("normalizeSheetMap heals legacy sales field payout → payout_amount", () => {
  const legacy: SheetMap = {
    tab: "Inventory",
    keyColumn: "SKU",
    createFromSheet: false,
    columns: [
      col({ header: "SKU", field: "sku", role: "key", writable: true }),
      col({ header: "Payout", field: "payout", table: "sales", kind: "currency" }),
    ],
  };
  const fixed = normalizeSheetMap(legacy);
  assertEquals(fixed.columns[1]!.field, "payout_amount");
  // a payout on the wrong TABLE is not touched (rename is sales-scoped)
  const notSales = normalizeSheetMap({
    ...legacy,
    columns: [col({ header: "Payout", field: "payout", table: "listings" })],
  });
  assertEquals(notSales.columns[0]!.field, "payout");
});

Deno.test("suggestFieldForHeader maps 'payout' to the real sales column", () => {
  assertEquals(suggestFieldForHeader("Payout")?.field, "payout_amount");
});

Deno.test("parseCurrency strips $ , and spaces", () => {
  assertEquals(parseCurrency("$2.20"), 2.2);
  assertEquals(parseCurrency("$1,250.00"), 1250);
  assertEquals(parseCurrency(" 15 "), 15);
  assertEquals(parseCurrency(""), null);
  assertEquals(parseCurrency("abc"), null);
});

Deno.test("parseSheetDate accepts MM/DD/YYYY and ISO, rejects partial", () => {
  assertEquals(parseSheetDate("01/10/2026"), "2026-01-10");
  assertEquals(parseSheetDate("1/9/2026"), "2026-01-09");
  assertEquals(parseSheetDate("2026-05-05"), "2026-05-05");
  assertEquals(parseSheetDate("1/12"), null); // no year — not a full date
  assertEquals(parseSheetDate("13/40/2026"), null); // out of range
  assertEquals(parseSheetDate(""), null);
});

Deno.test("formatSheetDate round-trips ISO → MM/DD/YYYY", () => {
  assertEquals(formatSheetDate("2026-01-10"), "01/10/2026");
  assertEquals(parseSheetDate(formatSheetDate("2026-01-10")), "2026-01-10");
});

Deno.test("parseMappedValue coerces by kind and guards negatives", () => {
  assertEquals(parseMappedValue(col({ kind: "currency", header: "Purchase Price" }), "$2.20"), {
    ok: true,
    value: 2.2,
  });
  assert(!parseMappedValue(col({ kind: "currency" }), "-3").ok);
  assertEquals(parseMappedValue(col({ kind: "date" }), "01/10/2026"), {
    ok: true,
    value: "2026-01-10",
  });
  assert(!parseMappedValue(col({ kind: "date" }), "1/12").ok);
  assertEquals(parseMappedValue(col({ kind: "string" }), "Cashmere"), {
    ok: true,
    value: "Cashmere",
  });
  // empty → null (caller guards key/NOT NULL)
  assertEquals(parseMappedValue(col({ kind: "string" }), ""), { ok: true, value: null });
});

Deno.test("parseMappedValue enum matches case-insensitively + labelMap", () => {
  const category = col({
    field: "item_category",
    kind: "enum",
    enumValues: ["clothing", "shoes"],
    header: "Category",
  });
  assertEquals(parseMappedValue(category, "Clothing"), { ok: true, value: "clothing" });
  assert(!parseMappedValue(category, "Widgets").ok);
  const withLabel = col({
    kind: "enum",
    enumValues: ["clothing"],
    labelMap: { apparel: "clothing" },
  });
  assertEquals(parseMappedValue(withLabel, "Apparel"), { ok: true, value: "clothing" });
});

Deno.test("formatMappedValue renders currency/date for the sheet", () => {
  assertEquals(formatMappedValue(col({ kind: "currency" }), 2.2), "$2.20");
  assertEquals(formatMappedValue(col({ kind: "date" }), "2026-01-10"), "01/10/2026");
  assertEquals(formatMappedValue(col({ kind: "string" }), null), "");
  assertEquals(formatMappedValue(col({ kind: "string" }), "Nike"), "Nike");
});

Deno.test("suggestFieldForHeader maps common flip-tracker headers", () => {
  assertEquals(suggestFieldForHeader("Item #")?.field, "sku");
  assertEquals(suggestFieldForHeader("Item #")?.role, "key");
  assertEquals(suggestFieldForHeader("Item Title")?.field, "title");
  assertEquals(suggestFieldForHeader("Purchase Price")?.kind, "currency");
  assertEquals(suggestFieldForHeader("Purchase Date")?.kind, "date");
  assertEquals(suggestFieldForHeader("Notes")?.field, "condition_notes");
  // Inventory is writable; listing/sale are read-only mirrors.
  assertEquals(suggestFieldForHeader("Brand")?.writable, true);
  assertEquals(suggestFieldForHeader("List Price")?.table, "listings");
  assertEquals(suggestFieldForHeader("List Price")?.writable, undefined);
  assertEquals(suggestFieldForHeader("Sale Price")?.table, "sales");
  // Unknown header → unmapped
  assertEquals(suggestFieldForHeader("📊 DASHBOARD"), null);
  assertEquals(suggestFieldForHeader("Column 1"), null);
});

const goodMap: SheetMap = {
  tab: "Thrift Flip Tracker",
  keyColumn: "Item #",
  createFromSheet: true,
  columns: [
    { header: "Item #", field: "sku", table: "inventory_items", role: "key" },
    { header: "Item Title", field: "title", table: "inventory_items", writable: true, kind: "string" },
    { header: "List Price", field: "listing_price", table: "listings", kind: "currency" },
  ],
};

Deno.test("validateSheetMap accepts a well-formed map", () => {
  assertEquals(validateSheetMap(goodMap), []);
});

// ── SKU-keyed merge primitives ────────────────────────────────────────
const keyCol: SheetMapColumn = { header: "Item #", field: "sku", table: "inventory_items", role: "key" };
const titleCol: SheetMapColumn = { header: "Item Title", field: "title", table: "inventory_items", writable: true, kind: "string" };
const priceCol: SheetMapColumn = { header: "Purchase Price", field: "acquired_price", table: "inventory_items", writable: true, kind: "currency" };
const listPriceCol: SheetMapColumn = { header: "List Price", field: "listing_price", table: "listings", kind: "currency" };
// Header layout with UNMAPPED columns interspersed (Comps, Dashboard) that must
// never be touched.
const HEADER = ["Item #", "Item Title", "Comps", "Purchase Price", "List Price", "📊 DASHBOARD"];
const mapForHeader: SheetMap = {
  tab: "Thrift Flip Tracker",
  keyColumn: "Item #",
  createFromSheet: true,
  columns: [keyCol, titleCol, priceCol, listPriceCol],
};

Deno.test("resolveMappedColumns locates mapped columns by header, ignores unmapped", () => {
  const r = resolveMappedColumns(mapForHeader, HEADER);
  assertEquals(r.errors, []);
  assertEquals(r.keyIndex, 0);
  // Item Title at 1, Purchase Price at 3, List Price at 4 (Comps=2 skipped).
  const byField = Object.fromEntries(r.columns.map((c) => [c.col.field, c.index]));
  assertEquals(byField.title, 1);
  assertEquals(byField.acquired_price, 3);
  assertEquals(byField.listing_price, 4);
});

Deno.test("resolveMappedColumns flags a missing key/column", () => {
  const r = resolveMappedColumns(mapForHeader, ["Item Title", "Purchase Price"]);
  assert(r.errors.some((e) => e.includes("Item #")));
  assertEquals(r.keyIndex, -1);
});

Deno.test("mergeMappedRow: GradeThread wins conflict; pull only when DB unchanged", () => {
  const writable: ResolvedMappedColumn[] = [
    { col: titleCol, index: 1 },
    { col: priceCol, index: 3 },
  ];
  // Sheet edited title (Nike→Nike Vintage), DB unchanged since base → would
  // pull, but US-2593 makes title create-only: GradeThread's value is pushed
  // back over the cell instead. Price edited on BOTH sides since base →
  // conflict → GT wins + push.
  const sheetCells = ["7", "Nike Vintage", "comps", "$5.00", "$20", "dash"];
  const dbRecord = { title: "Nike", acquired_price: 3 };
  const base = { title: "Nike", acquired_price: "2" };
  const m = mergeMappedRow(writable, sheetCells, dbRecord, base);
  assertEquals(m.pulls, {});
  assert(m.pushFields.has("title"), "a sheet title edit is rewritten from the DB");
  assertEquals(m.nextSnapshot.title, "Nike");
  assertEquals(m.conflicts.length, 1);
  assertEquals(m.conflicts[0]!.field, "acquired_price");
  assert(m.pushFields.has("acquired_price"));
  assertEquals(m.nextSnapshot.acquired_price, "3"); // GT value
});

// US-2593: create-only, not never-write. An item whose title is genuinely blank
// is still filled from the sheet — that is a fill, not an overwrite, and
// buildCreateFromSheet needs the same value to name a new item at all.
Deno.test("mergeMappedRow: a blank DB title is still filled from the sheet", () => {
  const writable: ResolvedMappedColumn[] = [{ col: titleCol, index: 1 }];
  const sheetCells = ["7", "Nike Vintage", "", "", "", ""];
  const m = mergeMappedRow(writable, sheetCells, { title: "" }, { title: "" });
  assertEquals(m.pulls, { title: "Nike Vintage" });
});

Deno.test("mergeMappedRow: FIRST contact adopts the sheet — fills empty DB, never blanks", () => {
  const writable: ResolvedMappedColumn[] = [
    { col: titleCol, index: 1 },
    { col: priceCol, index: 3 },
  ];
  // No snapshot (first sync). DB has a title but NO price; sheet has both.
  const sheetCells = ["7", "Nike", "comps", "$5.00", "$20", "dash"];
  const dbRecord = { title: "Nike Vintage", acquired_price: null };
  const m = mergeMappedRow(writable, sheetCells, dbRecord, undefined);
  // price: DB empty, sheet set → pull (fill DB). title: both set & differ →
  // adopt sheet as baseline, NO push (sheet untouched on first contact).
  assertEquals(m.pulls, { acquired_price: 5 });
  assertEquals(m.pushFields.size, 0, "first contact never writes the sheet");
  assertEquals(m.nextSnapshot.title, "Nike"); // baseline = the sheet value
  assertEquals(m.nextSnapshot.acquired_price, "5");
});

Deno.test("mergeMappedRow: never blanks title from the sheet", () => {
  const writable: ResolvedMappedColumn[] = [{ col: titleCol, index: 1 }];
  const sheetCells = ["7", "", "", "", "", ""]; // title emptied in sheet
  const m = mergeMappedRow(writable, sheetCells, { title: "Nike" }, { title: "Nike" });
  // sheet "" vs db "Nike": only-sheet-changed → would pull, but the DB title is
  // set, so US-2593 refuses it (and the NOT NULL guard behind it refuses too).
  assertEquals(m.pulls.title, undefined);
  assertEquals(m.nextSnapshot.title, "Nike");
});

Deno.test("mappedPushCells respects the merge's push decision; mirror is fill-only", () => {
  const cols: ResolvedMappedColumn[] = [
    { col: keyCol, index: 0 },
    { col: titleCol, index: 1 },
    { col: priceCol, index: 3 },
    { col: listPriceCol, index: 4 },
  ];
  const sheetCells = ["7", "Old Title", "comps", "$3.00", "$10", "dash"];
  const dbRecord = { sku: "7", title: "New Title", acquired_price: 3, listing_price: 25 };
  // Merge decided to push title; price wasn't decided-push; title also isn't pulled.
  const updates = mappedPushCells(cols, sheetCells, dbRecord, new Set(["title"]), new Set());
  const byIdx = Object.fromEntries(updates.map((u) => [u.colIndex, u.value]));
  assertEquals(byIdx[0], undefined, "key never rewritten");
  assertEquals(byIdx[1], "New Title", "writable field the merge decided to push");
  assertEquals(byIdx[3], undefined, "writable not in pushFields → not pushed");
  assertEquals(byIdx[4], "$25.00", "read-only mirror pushed (fill/update)");
});

Deno.test("mappedPushCells: mirror never blanks a seller's value with an empty DB", () => {
  const cols: ResolvedMappedColumn[] = [{ col: listPriceCol, index: 4 }];
  const sheetCells = ["7", "", "", "", "$15", ""]; // seller's historical list price
  const dbRecord = { listing_price: null }; // GradeThread has no listing yet
  const updates = mappedPushCells(cols, sheetCells, dbRecord, new Set(), new Set());
  assertEquals(updates.length, 0, "empty DB must not blank the seller's $15");
});

Deno.test("mappedPushCells: pulled field is never pushed back", () => {
  const cols: ResolvedMappedColumn[] = [{ col: titleCol, index: 1 }];
  const sheetCells = ["7", "Sheet Title", "", "", "", ""];
  const updates = mappedPushCells(
    cols,
    sheetCells,
    { title: "DB Title" },
    new Set(["title"]),
    new Set(["title"]),
  );
  assertEquals(updates.length, 0);
});

Deno.test("buildCreateFromSheet: fill-only insert, requires a title", () => {
  const writable: ResolvedMappedColumn[] = [
    { col: titleCol, index: 1 },
    { col: priceCol, index: 3 },
  ];
  const ok = buildCreateFromSheet(writable, { col: keyCol, index: 0 }, ["99", "Vintage Tee", "", "$4.50", "", ""], "99");
  assert("patch" in ok);
  if ("patch" in ok) {
    assertEquals(ok.patch, { sku: "99", title: "Vintage Tee", acquired_price: 4.5 });
    assertEquals(ok.snapshot.title, "Vintage Tee");
  }
  const noTitle = buildCreateFromSheet(writable, { col: keyCol, index: 0 }, ["100", "", "", "$4.50", "", ""], "100");
  assert("error" in noTitle);
});

Deno.test("validateSheetMap rejects missing/duplicate key, writable mirror, dup header", () => {
  assert(validateSheetMap({ ...goodMap, columns: [] }).length > 0); // no key
  assert(
    validateSheetMap({
      ...goodMap,
      columns: [
        ...goodMap.columns,
        // a listing field marked writable — not allowed
        { header: "List Price 2", field: "x", table: "listings", writable: true },
      ],
    }).some((e) => e.includes("read-only mirror")),
  );
  assert(
    validateSheetMap({
      ...goodMap,
      keyColumn: "Wrong Header",
    }).some((e) => e.includes("keyColumn")),
  );
});

// ── planUnmatchedSkus: the deleted-item resurrection guard ────────────────
// A deleted item's row stays in the seller's sheet, so create-from-sheet used to
// re-insert it on the next five-minute merge. Forever.

Deno.test("planUnmatchedSkus creates a SKU never synced before", () => {
  const plan = planUnmatchedSkus({
    sheetSkus: ["NEW-1"],
    itemSkus: new Set<string>(),
    snapshotSkus: new Set<string>(),
  });
  assertEquals(plan.create, ["NEW-1"]);
  assertEquals(plan.deleted, []);
  assertEquals(plan.staleSnapshots, []);
});

Deno.test("planUnmatchedSkus does NOT re-create an item deleted in FlipDesk", () => {
  // The snapshot is the evidence: we synced this SKU, so its item existed.
  const plan = planUnmatchedSkus({
    sheetSkus: ["GONE-1"],
    itemSkus: new Set<string>(),
    snapshotSkus: new Set(["GONE-1"]),
  });
  assertEquals(plan.create, []);
  assertEquals(plan.deleted, ["GONE-1"]);
  // The sheet row is still there, so the snapshot is NOT stale yet — dropping it
  // here would let the very next run resurrect the item.
  assertEquals(plan.staleSnapshots, []);
});

Deno.test("planUnmatchedSkus leaves matched SKUs alone", () => {
  const plan = planUnmatchedSkus({
    sheetSkus: ["A", "B"],
    itemSkus: new Set(["A", "B"]),
    snapshotSkus: new Set(["A", "B"]),
  });
  assertEquals(plan.create, []);
  assertEquals(plan.deleted, []);
  assertEquals(plan.staleSnapshots, []);
});

Deno.test("planUnmatchedSkus drops a snapshot with no item and no sheet row", () => {
  // Deleting the sheet row is the seller's lever: the snapshot goes, and the SKU
  // is creatable again on a future run.
  const plan = planUnmatchedSkus({
    sheetSkus: ["A"],
    itemSkus: new Set(["A"]),
    snapshotSkus: new Set(["A", "ORPHAN"]),
  });
  assertEquals(plan.create, []);
  assertEquals(plan.deleted, []);
  assertEquals(plan.staleSnapshots, ["ORPHAN"]);
});

Deno.test("planUnmatchedSkus keeps a snapshot whose item is only missing from the sheet", () => {
  // The item exists; the merge appends its row back. Nothing to clean up.
  const plan = planUnmatchedSkus({
    sheetSkus: [],
    itemSkus: new Set(["A"]),
    snapshotSkus: new Set(["A"]),
  });
  assertEquals(plan.staleSnapshots, []);
});

Deno.test("planUnmatchedSkus skips a renamed SKU instead of duplicating the item", () => {
  // The seller changed an item's SKU in FlipDesk. The sheet still holds the old
  // one, which used to create a SECOND item under the old SKU.
  const plan = planUnmatchedSkus({
    sheetSkus: ["OLD"],
    itemSkus: new Set(["NEW"]),
    snapshotSkus: new Set(["OLD"]),
  });
  assertEquals(plan.create, []);
  assertEquals(plan.deleted, ["OLD"]);
});
