// "Bring your own sheet" — pure logic for the user-defined COLUMN MAP that lets
// the Google Sheets sync drive the seller's OWN tab (matched/created by their
// SKU) instead of the generated, UUID-keyed tabs. Side-effect free + unit
// testable (types, value coercion, validation, header auto-suggest). The
// orchestration (Sheets API + Supabase writes, the SKU-keyed 3-way merge) lives
// in routes/flipdesk-google-sync.ts and reuses decideField() from sheet-sync.ts.

import {
  type CellKind,
  ITEM_CATEGORY_VALUES,
  ITEM_STATUS_VALUES,
  normalizeCell,
} from "./sheet-sync.ts";

export type MappedKind = "string" | "number" | "currency" | "date" | "enum";
export type MappedTable = "inventory_items" | "listings" | "sales";

// Real inventory_items columns safe to sync FROM the sheet (mirrors the fields
// the item-canvas save writes). A writable mapped column MUST target one of
// these — a map referencing anything else is rejected by validateSheetMap so a
// bad map can't crash the pull or blank an unknown column. "sku" is the key
// (matched, not written). "source" (store) needs FK resolution → not v1.
export const WRITABLE_INVENTORY_FIELDS: readonly string[] = [
  "sku",
  "title",
  "description",
  "brand",
  "style",
  "size",
  "color",
  "material",
  "condition_notes",
  "item_category",
  "container",
  "sourced_by",
  "acquired_date",
  "acquired_price",
  "target_price",
  "status",
  "location_bin",
];

export interface SheetMapColumn {
  /** The column header in the user's tab. */
  header: string;
  /** The DB field it maps to. */
  field: string;
  table: MappedTable;
  /** The SKU match/create key. Exactly one column carries this. */
  role?: "key";
  /** Pulled sheet→DB. Only inventory_items columns may be writable; listing/sale
   *  columns are a read-only mirror. The key column is matched, not written. */
  writable?: boolean;
  /** Value coercion; defaults to "string". */
  kind?: MappedKind;
  /** Allowed DB values for kind:"enum". */
  enumValues?: readonly string[];
  /** Optional sheet-label (lowercased) → DB value overrides for kind:"enum". */
  labelMap?: Record<string, string>;
}

export interface SheetMap {
  /** The tab title in the user's spreadsheet to sync. */
  tab: string;
  /** Header of the key column (the seller's SKU) rows are matched/created on. */
  keyColumn: string;
  /** New unique key in the sheet → create an inventory item (fill-only). */
  createFromSheet: boolean;
  columns: SheetMapColumn[];
}

export type MappedParse =
  | { ok: true; value: string | number | null }
  | { ok: false; error: string };

// ── Value coercion (sheet string → DB value) ──────────────────────────
export function parseCurrency(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse a sheet date to an ISO yyyy-mm-dd, or null when not a full date. */
export function parseSheetDate(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // MM/DD/YYYY
  if (us) {
    const mm = us[1]!.padStart(2, "0");
    const dd = us[2]!.padStart(2, "0");
    const mn = Number(mm), dn = Number(dd);
    if (mn < 1 || mn > 12 || dn < 1 || dn > 31) return null;
    return `${us[3]}-${mm}-${dd}`;
  }
  return null; // partial/ambiguous (e.g. "1/12" with no year) — not a full date
}

/** ISO yyyy-mm-dd → MM/DD/YYYY for display in the sheet. */
export function formatSheetDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

function resolveEnum(col: SheetMapColumn, normalized: string): string | null {
  const lower = normalized.trim().toLowerCase();
  if (col.labelMap && col.labelMap[lower]) return col.labelMap[lower];
  const allowed = col.enumValues ?? [];
  const hit = allowed.find((v) => v.toLowerCase() === lower);
  return hit ?? null;
}

/** Validate + coerce a normalized sheet cell for a mapped column. Empty → null
 *  (the caller guards the key column + NOT NULL fields like title). */
export function parseMappedValue(col: SheetMapColumn, normalized: string): MappedParse {
  if (normalized === "") return { ok: true, value: null };
  switch (col.kind) {
    case "currency": {
      const n = parseCurrency(normalized);
      if (n == null || n < 0) {
        return { ok: false, error: `"${normalized}" is not a valid ${col.header}` };
      }
      return { ok: true, value: n };
    }
    case "number": {
      const n = Number.parseFloat(normalized);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: `"${normalized}" is not a valid ${col.header}` };
      }
      return { ok: true, value: n };
    }
    case "date": {
      const iso = parseSheetDate(normalized);
      if (!iso) {
        return { ok: false, error: `"${normalized}" is not a valid ${col.header} (use MM/DD/YYYY)` };
      }
      return { ok: true, value: iso };
    }
    case "enum": {
      const v = resolveEnum(col, normalized);
      if (!v) {
        return { ok: false, error: `"${normalized}" is not a valid ${col.header}` };
      }
      return { ok: true, value: v };
    }
    default:
      return { ok: true, value: normalized };
  }
}

/** DB value → the string to write into the sheet cell for a mapped column. */
export function formatMappedValue(col: SheetMapColumn, value: unknown): string {
  if (value == null) return "";
  if (col.kind === "currency" && typeof value === "number") return `$${value.toFixed(2)}`;
  if (col.kind === "date" && typeof value === "string") return formatSheetDate(value);
  return String(value);
}

// ── Header auto-suggest (powers the mapping UI + seeds a default map) ──
// Maps common flip-tracker header synonyms to a GradeThread field. Inventory
// fields are two-way (writable); listing/sale fields are a read-only mirror.
type Suggestion = Omit<SheetMapColumn, "header">;

const HEADER_SUGGESTIONS: Record<string, Suggestion> = {
  // Key + inventory (two-way)
  "item #": { field: "sku", table: "inventory_items", role: "key" },
  "item#": { field: "sku", table: "inventory_items", role: "key" },
  "sku": { field: "sku", table: "inventory_items", role: "key" },
  "item title": { field: "title", table: "inventory_items", writable: true, kind: "string" },
  "title": { field: "title", table: "inventory_items", writable: true, kind: "string" },
  "item description": { field: "description", table: "inventory_items", writable: true, kind: "string" },
  "description": { field: "description", table: "inventory_items", writable: true, kind: "string" },
  "brand": { field: "brand", table: "inventory_items", writable: true, kind: "string" },
  "style": { field: "style", table: "inventory_items", writable: true, kind: "string" },
  "size": { field: "size", table: "inventory_items", writable: true, kind: "string" },
  "notes": { field: "condition_notes", table: "inventory_items", writable: true, kind: "string" },
  "category": {
    field: "item_category",
    table: "inventory_items",
    writable: true,
    kind: "enum",
    enumValues: ITEM_CATEGORY_VALUES,
  },
  "container": { field: "container", table: "inventory_items", writable: true, kind: "string" },
  "sourced by": { field: "sourced_by", table: "inventory_items", writable: true, kind: "string" },
  "color": { field: "color", table: "inventory_items", writable: true, kind: "string" },
  "material": { field: "material", table: "inventory_items", writable: true, kind: "string" },
  "target price": { field: "target_price", table: "inventory_items", writable: true, kind: "currency" },
  "location": { field: "location_bin", table: "inventory_items", writable: true, kind: "string" },
  "bin": { field: "location_bin", table: "inventory_items", writable: true, kind: "string" },
  "purchase date": { field: "acquired_date", table: "inventory_items", writable: true, kind: "date" },
  "purchase price": { field: "acquired_price", table: "inventory_items", writable: true, kind: "currency" },
  "cost": { field: "acquired_price", table: "inventory_items", writable: true, kind: "currency" },
  "cost basis": { field: "acquired_price", table: "inventory_items", writable: true, kind: "currency" },
  "status": {
    field: "status",
    table: "inventory_items",
    writable: true,
    kind: "enum",
    enumValues: ITEM_STATUS_VALUES,
  },
  // Listing / sale (read-only mirror)
  "listed": { field: "platform", table: "listings", kind: "string" },
  "list date": { field: "listed_at", table: "listings", kind: "date" },
  "links": { field: "listing_url", table: "listings", kind: "string" },
  "link": { field: "listing_url", table: "listings", kind: "string" },
  "list price": { field: "listing_price", table: "listings", kind: "currency" },
  "sale date": { field: "sold_at", table: "sales", kind: "date" },
  "sale price": { field: "sale_price", table: "sales", kind: "currency" },
  "fees": { field: "platform_fees", table: "sales", kind: "currency" },
  "shipping cost": { field: "shipping_cost", table: "sales", kind: "currency" },
  "net profit": { field: "net_profit", table: "sales", kind: "currency" },
  "payout": { field: "payout_amount", table: "sales", kind: "currency" },
  "tracking": { field: "tracking_number", table: "sales", kind: "string" },
};

/** Best-guess mapping for a header, or null when unknown (left unmapped). */
export function suggestFieldForHeader(header: string): SheetMapColumn | null {
  const s = HEADER_SUGGESTIONS[header.trim().toLowerCase()];
  return s ? { header, ...s } : null;
}

// The catalog of GradeThread fields a sheet column can map to — drives the
// mapping UI's per-column dropdown. Inventory fields are two-way (writable);
// listing/sale fields are a read-only mirror.
export interface MappableField {
  field: string;
  table: MappedTable;
  label: string;
  kind: MappedKind;
  writable: boolean;
  role?: "key";
  enumValues?: readonly string[];
}
export const MAPPABLE_FIELDS: readonly MappableField[] = [
  { field: "sku", table: "inventory_items", label: "SKU (match key)", kind: "string", writable: true, role: "key" },
  { field: "title", table: "inventory_items", label: "Title", kind: "string", writable: true },
  { field: "description", table: "inventory_items", label: "Description", kind: "string", writable: true },
  { field: "brand", table: "inventory_items", label: "Brand", kind: "string", writable: true },
  { field: "style", table: "inventory_items", label: "Style", kind: "string", writable: true },
  { field: "size", table: "inventory_items", label: "Size", kind: "string", writable: true },
  { field: "color", table: "inventory_items", label: "Color", kind: "string", writable: true },
  { field: "material", table: "inventory_items", label: "Material", kind: "string", writable: true },
  { field: "condition_notes", table: "inventory_items", label: "Notes", kind: "string", writable: true },
  { field: "item_category", table: "inventory_items", label: "Category", kind: "enum", writable: true, enumValues: ITEM_CATEGORY_VALUES },
  { field: "status", table: "inventory_items", label: "Status", kind: "enum", writable: true, enumValues: ITEM_STATUS_VALUES },
  { field: "container", table: "inventory_items", label: "Container", kind: "string", writable: true },
  { field: "sourced_by", table: "inventory_items", label: "Sourced By", kind: "string", writable: true },
  { field: "location_bin", table: "inventory_items", label: "Location / Bin", kind: "string", writable: true },
  { field: "acquired_date", table: "inventory_items", label: "Purchase Date", kind: "date", writable: true },
  { field: "acquired_price", table: "inventory_items", label: "Purchase Price", kind: "currency", writable: true },
  { field: "target_price", table: "inventory_items", label: "Target Price", kind: "currency", writable: true },
  // Read-only mirror (GradeThread/eBay owns these)
  { field: "platform", table: "listings", label: "Listed On (platform)", kind: "string", writable: false },
  { field: "listing_status", table: "listings", label: "Listing Status", kind: "string", writable: false },
  { field: "listing_price", table: "listings", label: "List Price", kind: "currency", writable: false },
  { field: "listing_url", table: "listings", label: "Listing Link", kind: "string", writable: false },
  { field: "listed_at", table: "listings", label: "List Date", kind: "date", writable: false },
  { field: "sale_price", table: "sales", label: "Sale Price", kind: "currency", writable: false },
  { field: "platform_fees", table: "sales", label: "Fees", kind: "currency", writable: false },
  { field: "shipping_cost", table: "sales", label: "Shipping Cost", kind: "currency", writable: false },
  { field: "net_profit", table: "sales", label: "Net Profit", kind: "currency", writable: false },
  { field: "payout_amount", table: "sales", label: "Payout", kind: "currency", writable: false },
  { field: "sold_at", table: "sales", label: "Sale Date", kind: "date", writable: false },
  { field: "tracking_number", table: "sales", label: "Tracking", kind: "string", writable: false },
];

// Back-compat: an early "bring your own sheet" build stored the Payout column
// with field "payout" — the items_full VIEW alias — instead of the real sales
// TABLE column "payout_amount". The mapped sync selects fields straight off the
// `sales` table, so such a map 42703'd ("column sales.payout does not exist").
// Rewrite legacy sales field ids on load so a map saved by that build syncs
// without the seller re-mapping. Safe to drop once no legacy maps remain.
const LEGACY_SALES_FIELD_RENAMES: Readonly<Record<string, string>> = {
  payout: "payout_amount",
};

export function normalizeSheetMap(map: SheetMap): SheetMap {
  let changed = false;
  const columns = map.columns.map((c) => {
    const renamed = c.table === "sales" ? LEGACY_SALES_FIELD_RENAMES[c.field] : undefined;
    if (!renamed) return c;
    changed = true;
    return { ...c, field: renamed };
  });
  return changed ? { ...map, columns } : map;
}

// ── Validation ────────────────────────────────────────────────────────
// ── SKU-keyed merge (the mapped analog of sheet-sync's mergeRow) ───────
// These are the row-level primitives the orchestration (runMappedMerge) glues
// together. Pure + tested so the risky part (writing a user's real sheet) is
// driven by verified logic. Mapped mode uses TARGETED per-cell updates keyed by
// column index — it NEVER rewrites a whole row, so unmapped columns (Comps, a
// dashboard, anything the seller keeps) are never touched.

/** How a mapped kind normalizes for change-detection (mirrors sheet-sync). */
function cellKindFor(kind?: MappedKind): CellKind {
  if (kind === "currency" || kind === "number") return "number";
  if (kind === "date") return "date";
  return "string";
}

export interface ResolvedMappedColumn {
  col: SheetMapColumn;
  /** 0-based column index in the sheet's header row. */
  index: number;
}
export interface ResolvedMap {
  columns: ResolvedMappedColumn[];
  /** 0-based index of the SKU key column, or -1 when the header lacks it. */
  keyIndex: number;
  errors: string[];
}

/** Resolve each mapped column to its position in the ACTUAL sheet header row.
 *  Columns whose header isn't present are dropped (with a note) so a renamed/
 *  removed sheet column degrades gracefully instead of writing to the wrong cell. */
export function resolveMappedColumns(
  map: SheetMap,
  headerRow: readonly unknown[],
): ResolvedMap {
  const idxByHeader = new Map<string, number>();
  headerRow.forEach((h, i) => {
    const key = String(h ?? "").trim().toLowerCase();
    if (key && !idxByHeader.has(key)) idxByHeader.set(key, i);
  });
  const columns: ResolvedMappedColumn[] = [];
  const errors: string[] = [];
  let keyIndex = -1;
  for (const col of map.columns) {
    const idx = idxByHeader.get(col.header.trim().toLowerCase());
    if (idx === undefined) {
      errors.push(`Column "${col.header}" not found in the sheet header.`);
      continue;
    }
    columns.push({ col, index: idx });
    if (col.role === "key") keyIndex = idx;
  }
  if (keyIndex < 0) {
    errors.push(`Key column "${map.keyColumn}" not found in the sheet header.`);
  }
  return { columns, keyIndex, errors };
}

export interface MappedFieldConflict {
  header: string;
  field: string;
  dbValue: string;
  sheetValue: string;
}
export interface MappedRowMerge {
  /** field → parsed value to write to inventory_items. */
  pulls: Record<string, string | number | null>;
  /** writable fields whose DB value should overwrite the sheet cell. */
  pushFields: Set<string>;
  conflicts: MappedFieldConflict[];
  /** field → normalized last-synced value (the next snapshot base). */
  nextSnapshot: Record<string, string>;
  errors: string[];
}

type MappedDecision = "none" | "pull" | "push" | "conflict";

// Per-field decision. On FIRST contact (no snapshot) the behavior is ADOPT —
// the user's sheet is the pre-existing source of truth (they seeded GradeThread
// from it), so we only ever FILL an empty DB field from the sheet and never
// write their sheet; the baseline is set to the sheet value so GradeThread's
// authority (conflict/push) kicks in from the NEXT sync onward. This makes the
// first sync of a real sheet non-destructive by construction. Once a snapshot
// exists it's the standard 3-way merge (GradeThread wins conflicts).
function decideMappedField(
  base: string | undefined,
  sheet: string,
  db: string,
): MappedDecision {
  if (sheet === db) return "none";
  if (base === undefined) {
    // Adopt: fill an empty DB from the sheet; otherwise leave both sides for the
    // next run (snapshot=sheet is set by the caller), never touching the sheet.
    return db === "" && sheet !== "" ? "pull" : "none";
  }
  const sheetChanged = sheet !== base;
  const dbChanged = db !== base;
  if (sheetChanged && dbChanged) return "conflict";
  if (sheetChanged) return "pull";
  return "push";
}

/** 3-way merge the WRITABLE inventory columns of one row. GradeThread wins
 *  conflicts once a baseline exists; the first sync ADOPTS the sheet (fill-only,
 *  no sheet writes) so a seller's existing data is never blanked. */
export function mergeMappedRow(
  writableCols: readonly ResolvedMappedColumn[],
  sheetCells: readonly unknown[],
  dbRecord: Record<string, unknown>,
  prevSnapshot: Record<string, string> | undefined,
): MappedRowMerge {
  const pulls: Record<string, string | number | null> = {};
  const pushFields = new Set<string>();
  const conflicts: MappedFieldConflict[] = [];
  const nextSnapshot: Record<string, string> = { ...(prevSnapshot ?? {}) };
  const errors: string[] = [];
  for (const { col, index } of writableCols) {
    if (col.role === "key") continue; // the key is matched, never pulled
    const ck = cellKindFor(col.kind);
    const sheetValue = normalizeCell(sheetCells[index], ck);
    const dbValue = normalizeCell(dbRecord[col.field], ck);
    const firstContact = prevSnapshot?.[col.field] === undefined;
    const decision = decideMappedField(prevSnapshot?.[col.field], sheetValue, dbValue);
    // First contact adopts the sheet as the baseline; otherwise the winning side
    // becomes the base (pull → sheet, push/conflict/none → db).
    if (decision === "pull") {
      // US-2593: the GradeThread title is the truth, so a mapped Title column is
      // CREATE-only. buildCreateFromSheet still names a new item from the sheet,
      // and an item whose title is somehow blank still gets filled — but once
      // there is a title, an edit to that cell is rewritten from the DB instead
      // of pulled. The seller edits the title in the composer, where the same
      // value goes to eBay.
      if (col.field === "title" && dbValue !== "") {
        pushFields.add(col.field);
        nextSnapshot[col.field] = dbValue;
        continue;
      }
      const parsed = parseMappedValue(col, sheetValue);
      // title is NOT NULL — never blank it from the sheet.
      if (!parsed.ok || (col.field === "title" && parsed.value === null)) {
        if (!parsed.ok) errors.push(parsed.error);
        nextSnapshot[col.field] = dbValue;
        continue;
      }
      pulls[col.field] = parsed.value;
      nextSnapshot[col.field] = sheetValue;
    } else if (decision === "conflict") {
      conflicts.push({ header: col.header, field: col.field, dbValue, sheetValue });
      pushFields.add(col.field); // GradeThread wins → overwrite the sheet cell
      nextSnapshot[col.field] = dbValue;
    } else if (decision === "push") {
      pushFields.add(col.field);
      nextSnapshot[col.field] = dbValue;
    } else {
      // none — on first contact adopt the sheet value as the base so GradeThread
      // authority applies from next run; otherwise the values already agree.
      nextSnapshot[col.field] = firstContact ? sheetValue : dbValue;
    }
  }
  return { pulls, pushFields, conflicts, nextSnapshot, errors };
}

export interface MappedCellUpdate {
  /** 0-based sheet column index. */
  colIndex: number;
  value: string;
}

/** Targeted cell writes to bring a row's mapped cells in line with the DB.
 *  Writable columns are pushed only when the merge DECIDED to (snapshot-aware,
 *  so first contact never writes the sheet). Read-only mirror columns
 *  (listing/sale) are FILL-ONLY — they update/fill from the DB but never BLANK a
 *  seller's historical value with an empty DB. The key + just-pulled fields are
 *  never written. Only these specific cells are touched — never a whole row. */
export function mappedPushCells(
  cols: readonly ResolvedMappedColumn[],
  sheetCells: readonly unknown[],
  dbRecord: Record<string, unknown>,
  pushFields: ReadonlySet<string>,
  pulledFields: ReadonlySet<string>,
): MappedCellUpdate[] {
  const out: MappedCellUpdate[] = [];
  for (const { col, index } of cols) {
    if (col.role === "key") continue; // never overwrite the seller's SKU
    if (pulledFields.has(col.field)) continue; // sheet already holds the value
    const ck = cellKindFor(col.kind);
    const desired = formatMappedValue(col, dbRecord[col.field]);
    const current = String(sheetCells[index] ?? "");
    if (normalizeCell(desired, ck) === normalizeCell(current, ck)) continue;
    if (col.writable) {
      if (!pushFields.has(col.field)) continue; // merge didn't decide to push
    } else if (desired === "") {
      continue; // mirror column: never blank the seller's historical value
    }
    out.push({ colIndex: index, value: desired });
  }
  return out;
}

/** The normalized snapshot (baseline) for a row's writable fields, taken from a
 *  DB record — used when APPENDING a DB item to the sheet so the next run sees
 *  sheet == db == base and does nothing. */
export function snapshotWritable(
  writableCols: readonly ResolvedMappedColumn[],
  record: Record<string, unknown>,
): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const { col } of writableCols) {
    if (col.role === "key") continue;
    snap[col.field] = normalizeCell(record[col.field], cellKindFor(col.kind));
  }
  return snap;
}

/** Build the fill-only inventory_items insert for a NEW sheet SKU (create-from-
 *  sheet). Only writable inventory columns with a non-null parsed value are set;
 *  returns null when a required field (title) is missing or a cell is invalid. */
export function buildCreateFromSheet(
  writableCols: readonly ResolvedMappedColumn[],
  keyCol: ResolvedMappedColumn,
  sheetCells: readonly unknown[],
  sku: string,
): { patch: Record<string, string | number>; snapshot: Record<string, string> } | { error: string } {
  const patch: Record<string, string | number> = { sku };
  const snapshot: Record<string, string> = {};
  for (const { col, index } of writableCols) {
    if (col.role === "key") continue;
    const ck = cellKindFor(col.kind);
    const norm = normalizeCell(sheetCells[index], ck);
    snapshot[col.field] = norm;
    if (norm === "") continue; // fill-only: skip blanks
    const parsed = parseMappedValue(col, norm);
    if (!parsed.ok) return { error: parsed.error };
    if (parsed.value !== null) patch[col.field] = parsed.value;
  }
  if (!patch.title || String(patch.title).trim() === "") {
    return { error: `New SKU "${sku}" has no Title — skipped` };
  }
  snapshot[keyCol.col.field] = sku;
  return { patch, snapshot };
}

/** Structural checks on a map before it drives a sync. Returns problems (empty = ok). */
export function validateSheetMap(map: SheetMap): string[] {
  const errors: string[] = [];
  if (!map.tab || !map.tab.trim()) errors.push("A target tab is required.");
  const keys = map.columns.filter((c) => c.role === "key");
  if (keys.length !== 1) {
    errors.push(`Exactly one key column is required (found ${keys.length}).`);
  } else {
    if (keys[0]!.field !== "sku") errors.push("The key column must map to sku.");
    if (keys[0]!.header !== map.keyColumn) {
      errors.push("keyColumn must match the key column's header.");
    }
  }
  const seenHeader = new Set<string>();
  const seenField = new Set<string>();
  for (const c of map.columns) {
    const h = c.header.trim().toLowerCase();
    if (seenHeader.has(h)) errors.push(`Duplicate mapped header: "${c.header}".`);
    seenHeader.add(h);
    const fk = `${c.table}.${c.field}`;
    if (seenField.has(fk)) errors.push(`Field mapped twice: ${fk}.`);
    seenField.add(fk);
    // Only inventory_items fields may be pulled back; listing/sale are mirrors.
    if (c.writable && c.table !== "inventory_items") {
      errors.push(`"${c.header}" (${c.table}) can't be writable — it's a read-only mirror.`);
    }
    // A writable column must target a real, sync-safe inventory column.
    if (c.writable && c.table === "inventory_items" && !WRITABLE_INVENTORY_FIELDS.includes(c.field)) {
      errors.push(`"${c.header}" → ${c.field} isn't a sync-safe inventory field.`);
    }
  }
  return errors;
}

/** What create-from-sheet should do with every SKU that has no FlipDesk item,
 *  plus the sync-state rows that no longer describe anything. */
export interface UnmatchedSkuPlan {
  /** Never synced before → a genuinely new sheet row. Create the item. */
  create: string[];
  /** Synced before, item gone → deleted in FlipDesk. Do NOT re-create it. */
  deleted: string[];
  /** A snapshot with neither an item nor a sheet row → drop the dead row. */
  staleSnapshots: string[];
}

/**
 * Decide the fate of every sheet SKU with no matching inventory item.
 *
 * THE BUG THIS FIXES: create-from-sheet used to insert an item for ANY sheet SKU
 * it could not match, and deleting an item in FlipDesk never touched the seller's
 * sheet. So the row stayed, the next scheduled merge (every 5 minutes) found a
 * SKU with no item, and re-created it. The seller deleted the same four items
 * over and over and watched them come back.
 *
 * A sync SNAPSHOT is the evidence that separates the two cases: we only ever
 * write one for a SKU we have actually synced, so a snapshot means the item
 * existed. Missing item + existing snapshot = deleted (or its SKU changed —
 * which used to create a DUPLICATE under the old SKU, so the same skip is right
 * there too). No snapshot = new in the sheet, which is what the feature is for.
 *
 * The seller's lever is the sheet row itself: delete it and the snapshot becomes
 * stale (no item, no row), gets dropped here, and the SKU is free to be created
 * again. That also keeps google_sheet_sync_state from growing forever.
 */
export function planUnmatchedSkus(args: {
  /** SKUs present in the sheet (all of them, matched or not). */
  sheetSkus: Iterable<string>;
  /** SKUs of the tenant's inventory items. */
  itemSkus: ReadonlySet<string>;
  /** SKUs carrying a sync snapshot for this tab. */
  snapshotSkus: ReadonlySet<string>;
}): UnmatchedSkuPlan {
  const plan: UnmatchedSkuPlan = { create: [], deleted: [], staleSnapshots: [] };
  const inSheet = new Set<string>();
  for (const sku of args.sheetSkus) {
    inSheet.add(sku);
    if (args.itemSkus.has(sku)) continue;
    (args.snapshotSkus.has(sku) ? plan.deleted : plan.create).push(sku);
  }
  for (const sku of args.snapshotSkus) {
    if (!args.itemSkus.has(sku) && !inSheet.has(sku)) plan.staleSnapshots.push(sku);
  }
  return plan;
}
