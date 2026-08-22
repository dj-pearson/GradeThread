// Google Sheets 2-way sync — pure logic (US-147).
//
// Everything here is deterministic and side-effect free (no Deno env, no DB,
// no fetch) so the merge engine is unit-testable: tab/column definitions, cell
// normalization, the 3-way field merge (base/sheet/db), pulled-value parsing,
// and chunking helpers. The orchestration (Sheets API calls, Supabase writes)
// lives in routes/flipdesk-google-sync.ts.

export type CellKind = "string" | "number" | "date";

export interface ColumnDef {
  /** Header shown in row 1 of the sheet. */
  header: string;
  /** DB column the cell mirrors. */
  field: string;
  kind: CellKind;
  /** Pulled from the sheet into FlipDesk. Absent/false = read-only in sheet. */
  writable?: boolean;
  /** Data-validation dropdown values for enum columns. */
  enumValues?: readonly string[];
}

// Enum values mirrored from supabase/migrations (00002 + 00008). Keep in sync
// if the Postgres enums grow — pull validation rejects values outside these.
export const ITEM_STATUS_VALUES = [
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "grading",
  "graded",
  "comped",
  "drafted",
  "listed",
  "sold",
  "shipped",
  "completed",
  "returned",
  "archived",
] as const;

export const ITEM_CATEGORY_VALUES = [
  "clothing",
  "shoes",
  "watches",
  "sports_cards",
  "collectibles",
  "electronics",
  "books",
  // US-2797: jewelry/bags/accessories arrived with migration 00230 and
  // headwear with 00570; this list learned none of them. A value absent here
  // is not rejected loudly, it is dropped or refused while the database would
  // have taken it.
  "jewelry",
  "bags",
  "accessories",
  "headwear",
  "other",
] as const;

export const LISTING_STATUS_VALUES = [
  "draft",
  "active",
  "ended",
  "sold",
  "relisted",
] as const;

export const SOURCE_TYPE_VALUES = [
  "thrift",
  "goodwill_auction",
  "estate_sale",
  "wholesale",
  "retail_arbitrage",
  "consignment",
  "other",
] as const;

// Column A of every data tab is the hidden flipdesk_id join key (AC: each row
// carries a hidden flipdesk_id column). It is NOT in the ColumnDef lists below
// — serialization prepends it.
export const ID_HEADER = "flipdesk_id";

// The per-field allow-list (AC): only these flow Sheets → FlipDesk. Everything
// else is read-only in the sheet (light gray fill).
export const INVENTORY_COLUMNS: readonly ColumnDef[] = [
  { header: "SKU", field: "sku", kind: "string", writable: true },
  // US-2593: the GradeThread title is the truth. Title is a read-only mirror —
  // it renders with the gray read-only fill and any edit in the sheet is
  // rewritten from the DB on the next sync. The seller edits it in the composer,
  // where it also drives the eBay listing; two writable copies of the same
  // sentence just meant whichever side was touched last won.
  { header: "Title", field: "title", kind: "string" },
  { header: "Brand", field: "brand", kind: "string", writable: true },
  { header: "Size", field: "size", kind: "string", writable: true },
  { header: "Category", field: "item_category", kind: "string", enumValues: ITEM_CATEGORY_VALUES },
  { header: "Status", field: "status", kind: "string", writable: true, enumValues: ITEM_STATUS_VALUES },
  { header: "Cost Basis", field: "acquired_price", kind: "number", writable: true },
  { header: "Target Price", field: "target_price", kind: "number", writable: true },
  { header: "Notes", field: "condition_notes", kind: "string", writable: true },
  { header: "Grade", field: "grade_value", kind: "number" },
  { header: "Location Bin", field: "location_bin", kind: "string" },
  { header: "Created", field: "created_at", kind: "date" },
  { header: "Updated", field: "updated_at", kind: "date" },
] as const;

export const LISTINGS_COLUMNS: readonly ColumnDef[] = [
  { header: "Title", field: "listing_title", kind: "string" },
  { header: "Platform", field: "platform", kind: "string" },
  { header: "Status", field: "listing_status", kind: "string", enumValues: LISTING_STATUS_VALUES },
  { header: "Price", field: "listing_price", kind: "number" },
  { header: "Watchers", field: "watchers", kind: "number" },
  { header: "Views", field: "views", kind: "number" },
  { header: "URL", field: "listing_url", kind: "string" },
  { header: "Listed At", field: "listed_at", kind: "date" },
  { header: "Updated", field: "updated_at", kind: "date" },
] as const;

export const SALES_COLUMNS: readonly ColumnDef[] = [
  { header: "Sale Price", field: "sale_price", kind: "number" },
  { header: "Platform Fees", field: "platform_fees", kind: "number" },
  { header: "Shipping Collected", field: "shipping_collected", kind: "number" },
  { header: "Shipping Cost", field: "shipping_cost", kind: "number" },
  { header: "Net Profit", field: "net_profit", kind: "number" },
  { header: "Buyer", field: "buyer_username", kind: "string" },
  { header: "Sold At", field: "sold_at", kind: "date" },
  { header: "Created", field: "created_at", kind: "date" },
] as const;

export const SOURCES_COLUMNS: readonly ColumnDef[] = [
  { header: "Name", field: "name", kind: "string" },
  { header: "Type", field: "source_type", kind: "string", enumValues: SOURCE_TYPE_VALUES },
  { header: "Location", field: "location", kind: "string" },
  { header: "Notes", field: "notes", kind: "string" },
  { header: "Updated", field: "updated_at", kind: "date" },
] as const;

export interface TabDef {
  title: string;
  columns: readonly ColumnDef[];
  /** Any column pulled back from the sheet? Drives snapshot bookkeeping. */
  writable: boolean;
}

export const DATA_TABS: readonly TabDef[] = [
  { title: "Inventory", columns: INVENTORY_COLUMNS, writable: true },
  { title: "Listings", columns: LISTINGS_COLUMNS, writable: false },
  { title: "Sales", columns: SALES_COLUMNS, writable: false },
  { title: "Sources", columns: SOURCES_COLUMNS, writable: false },
] as const;

export const SYNC_LOG_TAB = "Sync Log";
export const SYNC_LOG_HEADERS = [
  "Timestamp",
  "Trigger",
  "Rows Pushed",
  "Rows Pulled",
  "Conflicts",
  "Errors",
] as const;

export const CONFLICTS_TAB = "Conflicts";
export const CONFLICTS_HEADERS = [
  "Detected At",
  "Tab",
  ID_HEADER,
  "Item",
  "Field",
  "FlipDesk Value",
  "Sheet Value",
  "Action",
  "Status",
] as const;
export const CONFLICT_ACTION_KEEP = "Keep FlipDesk";
export const CONFLICT_ACTION_ACCEPT_SHEET = "Accept Sheet";
export const CONFLICT_STATUS_OPEN = "Open";
export const CONFLICT_STATUS_APPLIED = "Applied";
// US-1083: a sheet edit to an eBay-owned field on an eBay-originated (locked)
// listing is surfaced here so the user sees what was NOT synced and why. It is
// never re-processed (status ≠ Open), and the row carries no usable Action.
export const CONFLICT_ACTION_LOCKED = "Locked";
export const CONFLICT_STATUS_SKIPPED = "Skipped — edit on eBay";

// ── Cell normalization ────────────────────────────────────────────────
// Both sides of every comparison go through this so "12.50" (typed in the
// sheet) equals 12.5 (Postgres numeric) and null equals "". All comparisons in
// the merge are over normalized strings.
export function normalizeCell(value: unknown, kind: CellKind): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  const s = String(value).trim();
  if (s === "") return "";
  if (kind === "number") {
    // Tolerate currency formatting the user may type into the sheet.
    const n = Number.parseFloat(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? String(n) : s;
  }
  return s;
}

/** Serialize one DB record to a sheet row: [flipdesk_id, ...normalized cells]. */
export function recordToRow(
  record: Record<string, unknown>,
  columns: readonly ColumnDef[],
): string[] {
  const cells = columns.map((col) => {
    const v = record[col.field];
    if (col.kind === "date" && typeof v === "string" && v) {
      // Stable ISO form (Postgres returns offsets like +00:00; normalize once
      // so the same instant never diffs against itself).
      const t = new Date(v);
      return Number.isNaN(t.getTime()) ? v : t.toISOString();
    }
    return normalizeCell(v, col.kind);
  });
  return [String(record.id ?? ""), ...cells];
}

// ── 3-way field merge ─────────────────────────────────────────────────
export type FieldDecision = "none" | "push" | "pull" | "conflict";

/**
 * Decide what to do with one writable field given its value at the last sync
 * (`base`), in the sheet, and in FlipDesk. All three are normalized strings;
 * `base` is undefined when no snapshot exists yet (first sync / pre-existing
 * sheet) — FlipDesk wins then, so a stale sheet can never overwrite the DB.
 */
export function decideField(
  base: string | undefined,
  sheetValue: string,
  dbValue: string,
): FieldDecision {
  if (sheetValue === dbValue) return "none";
  if (base === undefined) return "push";
  const sheetChanged = sheetValue !== base;
  const dbChanged = dbValue !== base;
  if (sheetChanged && dbChanged) return "conflict";
  return sheetChanged ? "pull" : "push";
}

export interface FieldConflict {
  field: string;
  header: string;
  dbValue: string;
  sheetValue: string;
}

export interface RowMerge {
  /** field → normalized sheet value to apply to the DB. */
  pulls: Record<string, string>;
  /** True if any cell (writable or read-only) differs from the DB → rewrite row. */
  needsPush: boolean;
  conflicts: FieldConflict[];
  /** Snapshot of writable fields AFTER this sync settles (db wins conflicts). */
  nextSnapshot: Record<string, string>;
}

/**
 * Merge one sheet row against its DB record. `sheetRow`/`dbRow` are full
 * serialized rows ([id, ...cells]); `snapshot` maps field → base value.
 * Read-only cells never pull — any drift there just marks the row for push.
 */
export function mergeRow(
  columns: readonly ColumnDef[],
  sheetRow: readonly string[],
  dbRow: readonly string[],
  snapshot: Record<string, string> | undefined,
): RowMerge {
  const pulls: Record<string, string> = {};
  const conflicts: FieldConflict[] = [];
  const nextSnapshot: Record<string, string> = {};
  let needsPush = false;

  columns.forEach((col, i) => {
    const sheetValue = normalizeCell(sheetRow[i + 1], col.kind);
    const dbValue = dbRow[i + 1] ?? "";
    if (!col.writable) {
      if (sheetValue !== dbValue) needsPush = true;
      return;
    }
    const base = snapshot?.[col.field];
    const decision = decideField(base, sheetValue, dbValue);
    switch (decision) {
      case "pull":
        pulls[col.field] = sheetValue;
        nextSnapshot[col.field] = sheetValue;
        break;
      case "conflict":
        conflicts.push({ field: col.field, header: col.header, dbValue, sheetValue });
        nextSnapshot[col.field] = dbValue; // FlipDesk wins by default
        needsPush = true; // rewrite the cell with the winning value
        break;
      case "push":
        nextSnapshot[col.field] = dbValue;
        needsPush = true;
        break;
      default:
        nextSnapshot[col.field] = dbValue;
    }
  });

  return { pulls, needsPush, conflicts, nextSnapshot };
}

// ── Pulled-value parsing (sheet string → DB value) ────────────────────
export type ParseResult =
  | { ok: true; value: string | number | null }
  | { ok: false; error: string };

/** Validate + coerce a normalized sheet value for writing to the DB column. */
export function parsePulledValue(col: ColumnDef, normalized: string): ParseResult {
  if (normalized === "") {
    // sku is the identity / CSV-match / duplicate-merge key — blanking it
    // silently orphans future matching. Refuse to empty it from the sheet (the
    // cell is rewritten back from the DB). `title` is kept here even though the
    // classic Inventory tab no longer pulls it (US-2593): the guard is the last
    // line for any caller that makes a title column writable again, and title
    // is NOT NULL in the schema.
    if (col.field === "title" || col.field === "sku") {
      return { ok: false, error: `${col.header} cannot be emptied from the sheet` };
    }
    return { ok: true, value: null };
  }
  if (col.enumValues && !(col.enumValues as readonly string[]).includes(normalized)) {
    return {
      ok: false,
      error: `"${normalized}" is not a valid ${col.header} (expected one of: ${col.enumValues.join(", ")})`,
    };
  }
  if (col.kind === "number") {
    const n = Number.parseFloat(normalized);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `"${normalized}" is not a valid ${col.header}` };
    }
    return { ok: true, value: n };
  }
  return { ok: true, value: normalized };
}

// ── Tab structure setup (spreadsheets.batchUpdate requests) ───────────
const READ_ONLY_FILL = { red: 0.93, green: 0.94, blue: 0.95 }; // light gray

function headerRowRequest(sheetId: number, headers: readonly string[]) {
  return {
    updateCells: {
      rows: [{
        values: headers.map((h) => ({ userEnteredValue: { stringValue: h } })),
      }],
      fields: "userEnteredValue",
      start: { sheetId, rowIndex: 0, columnIndex: 0 },
    },
  };
}

function freezeHeaderRequest(sheetId: number) {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: "gridProperties.frozenRowCount",
    },
  };
}

function boldHeaderRequest(sheetId: number) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: "userEnteredFormat.textFormat.bold",
    },
  };
}

function hideColumnRequest(sheetId: number, columnIndex: number) {
  return {
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension: "COLUMNS",
        startIndex: columnIndex,
        endIndex: columnIndex + 1,
      },
      properties: { hiddenByUser: true },
      fields: "hiddenByUser",
    },
  };
}

function validationRequest(
  sheetId: number,
  columnIndex: number,
  values: readonly string[],
) {
  return {
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: 1,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rule: {
        condition: {
          type: "ONE_OF_LIST",
          values: values.map((v) => ({ userEnteredValue: v })),
        },
        showCustomUi: true,
        strict: false,
      },
    },
  };
}

function grayFillRequest(sheetId: number, startCol: number, endCol: number) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 1,
        startColumnIndex: startCol,
        endColumnIndex: endCol,
      },
      cell: { userEnteredFormat: { backgroundColor: READ_ONLY_FILL } },
      fields: "userEnteredFormat.backgroundColor",
    },
  };
}

/**
 * Build the spreadsheets.batchUpdate requests that turn a bare tab into its
 * sync shape: header row (bold, frozen), hidden flipdesk_id column, enum
 * dropdown validation, and light-gray fill on read-only columns. Idempotent —
 * safe to re-run on an already-configured tab.
 */
export function buildTabSetupRequests(
  sheetId: number,
  tabTitle: string,
): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [freezeHeaderRequest(sheetId), boldHeaderRequest(sheetId)];

  if (tabTitle === SYNC_LOG_TAB) {
    requests.push(headerRowRequest(sheetId, SYNC_LOG_HEADERS));
    return requests;
  }

  if (tabTitle === CONFLICTS_TAB) {
    requests.push(headerRowRequest(sheetId, CONFLICTS_HEADERS));
    const actionCol = CONFLICTS_HEADERS.indexOf("Action");
    requests.push(
      validationRequest(sheetId, actionCol, [
        CONFLICT_ACTION_KEEP,
        CONFLICT_ACTION_ACCEPT_SHEET,
      ]),
      // Everything except the Action dropdown is informational.
      grayFillRequest(sheetId, 0, actionCol),
      grayFillRequest(sheetId, actionCol + 1, CONFLICTS_HEADERS.length),
    );
    return requests;
  }

  const tab = DATA_TABS.find((t) => t.title === tabTitle);
  if (!tab) return requests;

  requests.push(
    headerRowRequest(sheetId, [ID_HEADER, ...tab.columns.map((c) => c.header)]),
    hideColumnRequest(sheetId, 0),
  );
  tab.columns.forEach((col, i) => {
    // Only WRITABLE enum columns get the editing dropdown. A read-only enum
    // (e.g. Category) with a dropdown looks editable but its edits are silently
    // reverted on the next sync — so render it gray/read-only instead.
    if (col.enumValues && col.writable) {
      requests.push(validationRequest(sheetId, i + 1, col.enumValues));
    }
    if (!col.writable) requests.push(grayFillRequest(sheetId, i + 1, i + 2));
  });
  return requests;
}

// ── Misc helpers ──────────────────────────────────────────────────────
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 0-based column index → A1 letter(s): 0→A, 25→Z, 26→AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
