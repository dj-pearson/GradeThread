// Google Sheets 2-way sync (US-147): the 3-way merge engine, cell
// normalization, pulled-value validation against the per-field allow-list,
// and the tab setup request builder. All pure — no env/db/network.
//   deno test src/tests/google-sheet-sync_test.ts
import { assert, assertEquals } from "@std/assert";
import {
  buildTabSetupRequests,
  chunk,
  columnLetter,
  CONFLICT_ACTION_ACCEPT_SHEET,
  CONFLICT_ACTION_KEEP,
  CONFLICTS_TAB,
  DATA_TABS,
  decideField,
  ID_HEADER,
  INVENTORY_COLUMNS,
  ITEM_STATUS_VALUES,
  mergeRow,
  normalizeCell,
  parsePulledValue,
  recordToRow,
  SYNC_LOG_TAB,
} from "../lib/sheet-sync.ts";

// ── normalization ─────────────────────────────────────────────────────
Deno.test("normalizeCell equates sheet formatting with DB values", () => {
  assertEquals(normalizeCell(null, "string"), "");
  assertEquals(normalizeCell(undefined, "number"), "");
  assertEquals(normalizeCell(12.5, "number"), "12.5");
  // "$12.50" typed in the sheet equals Postgres numeric 12.5
  assertEquals(normalizeCell("$12.50", "number"), "12.5");
  assertEquals(normalizeCell("1,250.00", "number"), "1250");
  assertEquals(normalizeCell("  Nike  ", "string"), "Nike");
});

// ── 3-way field merge ─────────────────────────────────────────────────
Deno.test("decideField: equal values are a no-op", () => {
  assertEquals(decideField("a", "x", "x"), "none");
  assertEquals(decideField(undefined, "x", "x"), "none");
});

Deno.test("decideField: only-sheet-changed pulls, only-db-changed pushes", () => {
  assertEquals(decideField("base", "edited", "base"), "pull");
  assertEquals(decideField("base", "base", "edited"), "push");
});

Deno.test("decideField: both changed → conflict; no snapshot → FlipDesk wins", () => {
  assertEquals(decideField("base", "sheet-edit", "db-edit"), "conflict");
  // First sync against a pre-existing sheet: never let stale data overwrite DB.
  assertEquals(decideField(undefined, "stale", "fresh"), "push");
});

Deno.test("mergeRow splits pulls / pushes / conflicts per field", () => {
  // Columns: SKU(writable) Title(read-only, US-2593) ... Grade(read-only).
  const record = {
    id: "11111111-1111-1111-1111-111111111111",
    sku: "A-1",
    title: "Vintage Tee",
    brand: "Nike",
    size: "L",
    item_category: "clothing",
    status: "listed",
    acquired_price: 5,
    target_price: 25,
    condition_notes: null,
    grade_value: 8.5,
    location_bin: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-02T00:00:00.000Z",
  };
  const dbRow = recordToRow(record, INVENTORY_COLUMNS);
  // Sheet: user edited Brand (pull), Title drifted (read-only → push, never a
  // conflict), both edited SKU differently (conflict).
  const sheetRow = [...dbRow];
  const idx = (field: string) => INVENTORY_COLUMNS.findIndex((c) => c.field === field) + 1;
  sheetRow[idx("brand")] = "Adidas";
  sheetRow[idx("title")] = "Old Title";
  sheetRow[idx("sku")] = "SHEET-SKU";
  const snapshot: Record<string, string> = {
    sku: "OLD-SKU", // both sides differ from base → conflict
    brand: "Nike", // db == base, sheet changed → pull
    size: "L",
    status: "listed",
    acquired_price: "5",
    target_price: "25",
    condition_notes: "",
  };

  const merge = mergeRow(INVENTORY_COLUMNS, sheetRow, dbRow, snapshot);
  assertEquals(merge.pulls, { brand: "Adidas" });
  assertEquals(merge.conflicts.length, 1);
  assertEquals(merge.conflicts[0]!.field, "sku");
  assertEquals(merge.conflicts[0]!.dbValue, "A-1");
  assertEquals(merge.conflicts[0]!.sheetValue, "SHEET-SKU");
  assert(merge.needsPush, "title drift + sku conflict must rewrite the row");
  // FlipDesk wins the conflict; the pull settles to the sheet value.
  assertEquals(merge.nextSnapshot.sku, "A-1");
  assertEquals(merge.nextSnapshot.brand, "Adidas");
  // US-2593: title is read-only now, so it is neither pulled nor snapshotted —
  // the sheet cell is simply rewritten from the DB.
  assertEquals(merge.pulls.title, undefined);
  assertEquals(merge.nextSnapshot.title, undefined);
});

// US-2593. The seller's typed title lives on the listing and on the item, and
// only the listing copy ever moved — so the Inventory tab kept the name the
// item was created with. The rule the owner chose: GradeThread is the truth and
// the sheet cell is a mirror.
Deno.test("mergeRow: an edited Title cell is rewritten from the DB, never pulled", () => {
  const record = {
    id: "33333333-3333-3333-3333-333333333333",
    sku: "C-3",
    title: "Lululemon Men's ABC Pants Slate Blue Straight Fit Size 36",
    brand: "Lululemon",
    size: "36",
    item_category: "clothing",
    status: "listed",
    acquired_price: null,
    target_price: null,
    condition_notes: null,
    grade_value: null,
    location_bin: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
  };
  const dbRow = recordToRow(record, INVENTORY_COLUMNS);
  const sheetRow = [...dbRow];
  const titleIdx = INVENTORY_COLUMNS.findIndex((c) => c.field === "title") + 1;
  sheetRow[titleIdx] = "Lululemon Men's ABC Pants Slate Blue Straight Fit Size Medium";
  const merge = mergeRow(INVENTORY_COLUMNS, sheetRow, dbRow, { title: "whatever" });
  assertEquals(merge.pulls.title, undefined, "a sheet title must never reach the DB");
  assertEquals(merge.conflicts.length, 0, "read-only drift is not a conflict");
  assert(merge.needsPush, "the stale cell must be rewritten from the DB");
});

Deno.test("mergeRow: read-only drift never pulls, only pushes", () => {
  const record = {
    id: "22222222-2222-2222-2222-222222222222",
    sku: "B-2",
    title: "Jacket",
    brand: null,
    size: null,
    item_category: null,
    status: "acquired",
    acquired_price: null,
    target_price: null,
    condition_notes: null,
    grade_value: 9,
    location_bin: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
  };
  const dbRow = recordToRow(record, INVENTORY_COLUMNS);
  const sheetRow = [...dbRow];
  const gradeIdx = INVENTORY_COLUMNS.findIndex((c) => c.field === "grade_value") + 1;
  sheetRow[gradeIdx] = "10"; // user tampered with the read-only Grade cell
  const merge = mergeRow(INVENTORY_COLUMNS, sheetRow, dbRow, undefined);
  assertEquals(Object.keys(merge.pulls).length, 0);
  assert(merge.needsPush, "tampered read-only cell must be rewritten from DB");
  assertEquals(merge.conflicts.length, 0);
});

// ── pulled-value validation (the allow-list) ──────────────────────────
Deno.test("only the allow-listed fields are writable from the sheet", () => {
  const writable = INVENTORY_COLUMNS.filter((c) => c.writable).map((c) => c.field).sort();
  assertEquals(writable, [
    "acquired_price", // cost_basis
    "brand",
    "condition_notes", // notes
    "size",
    "sku",
    "status",
    "target_price",
  ]);
  // Financial/system fields stay read-only — and since US-2593 so does Title.
  for (const field of ["title", "grade_value", "item_category", "created_at", "updated_at"]) {
    const col = INVENTORY_COLUMNS.find((c) => c.field === field)!;
    assert(!col.writable, `${field} must be read-only in the sheet`);
  }
});

Deno.test("parsePulledValue validates enums and numbers, protects title", () => {
  const status = INVENTORY_COLUMNS.find((c) => c.field === "status")!;
  assertEquals(parsePulledValue(status, "listed"), { ok: true, value: "listed" });
  assert(!parsePulledValue(status, "not-a-status").ok);
  assert(ITEM_STATUS_VALUES.includes("photographed"), "pipeline statuses present");

  const price = INVENTORY_COLUMNS.find((c) => c.field === "acquired_price")!;
  assertEquals(parsePulledValue(price, "12.5"), { ok: true, value: 12.5 });
  assert(!parsePulledValue(price, "-3").ok);
  assertEquals(parsePulledValue(price, ""), { ok: true, value: null });

  // Title no longer pulls at all (US-2593), but the blank guard stays as the
  // last line for any future caller that makes a title column writable.
  const title = INVENTORY_COLUMNS.find((c) => c.field === "title")!;
  assert(!parsePulledValue(title, "").ok, "title is NOT NULL — can't blank it");

  // SKU is the identity / CSV-match / merge key — blanking it from the sheet is
  // refused (would silently orphan future matching), like title.
  const sku = INVENTORY_COLUMNS.find((c) => c.field === "sku")!;
  assert(!parsePulledValue(sku, "").ok, "sku is the merge key — can't blank it");
  assertEquals(parsePulledValue(sku, "ABC-123"), { ok: true, value: "ABC-123" });

  // Category is read-only in the sheet (not writable) — it never reaches a pull,
  // but if parsed it still coerces normally.
  const category = INVENTORY_COLUMNS.find((c) => c.field === "item_category")!;
  assertEquals(category.writable, undefined);
});

// ── tab setup requests ────────────────────────────────────────────────
Deno.test("buildTabSetupRequests: data tab gets header, frozen row, hidden id, validation, gray fill", () => {
  const reqs = buildTabSetupRequests(7, "Inventory");
  const kinds = reqs.map((r) => Object.keys(r)[0]);
  assert(kinds.includes("updateSheetProperties"), "frozen header row");
  assert(kinds.includes("updateCells"), "header values");
  assert(kinds.includes("updateDimensionProperties"), "hidden flipdesk_id col");
  assert(kinds.includes("setDataValidation"), "enum dropdowns");
  assert(kinds.includes("repeatCell"), "read-only gray fill");

  const header = (reqs.find((r) => "updateCells" in r) as {
    updateCells: { rows: { values: { userEnteredValue: { stringValue: string } }[] }[] };
  }).updateCells.rows[0]!.values.map((v) => v.userEnteredValue.stringValue);
  assertEquals(header[0], ID_HEADER);
  assertEquals(header.length, INVENTORY_COLUMNS.length + 1);

  // Only WRITABLE enum columns get a dropdown: Status is writable → dropdown;
  // Category is read-only → gray fill, NO dropdown (a dropdown on a read-only
  // cell looks editable but its edits are silently reverted).
  const validations = reqs.filter((r) => "setDataValidation" in r);
  assertEquals(validations.length, 1);
});

Deno.test("buildTabSetupRequests: Conflicts tab offers the two resolution actions", () => {
  const reqs = buildTabSetupRequests(3, CONFLICTS_TAB);
  const validation = reqs.find((r) => "setDataValidation" in r) as {
    setDataValidation: { rule: { condition: { values: { userEnteredValue: string }[] } } };
  };
  const actions = validation.setDataValidation.rule.condition.values.map((v) => v.userEnteredValue);
  assertEquals(actions, [CONFLICT_ACTION_KEEP, CONFLICT_ACTION_ACCEPT_SHEET]);
});

Deno.test("all five required tabs are defined", () => {
  const titles = [...DATA_TABS.map((t) => t.title), SYNC_LOG_TAB];
  assertEquals(titles, ["Inventory", "Listings", "Sales", "Sources", "Sync Log"]);
});

// ── helpers ───────────────────────────────────────────────────────────
Deno.test("columnLetter + chunk", () => {
  assertEquals(columnLetter(0), "A");
  assertEquals(columnLetter(13), "N");
  assertEquals(columnLetter(25), "Z");
  assertEquals(columnLetter(26), "AA");
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunk([], 10), []);
});
