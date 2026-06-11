// US-468: pure helpers for turning eBay order line items into FlipDesk sale
// rows correctly when an order is multi-quantity (one line, quantity > 1) or
// multi-line for the same inventory item (the same item sold twice in one
// order). Pure + dependency-free so the unit-count and dedupe-selection logic
// is testable without a DB or the eBay API.
//
// IMPORTANT financial note: eBay's `lineItem.lineItemCost` is the EXTENDED line
// total — unit price × quantity, not a per-unit price (verified against the
// Fulfillment API LineItem docs). So `sale_price` = lineItemCost is already the
// correct line revenue and must NEVER be multiplied by quantity again. The
// per-unit helper below exists only for display/sanity, not for revenue.

/** eBay lineItem.quantity → a positive integer unit count (defaults to 1). */
export function normalizeUnitCount(qty: number | null | undefined): number {
  const n = Number(qty);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * Per-unit price derived from the extended line total and unit count. Returns 0
 * for a non-positive/blank total. For display only — revenue uses the extended
 * total directly.
 */
export function perUnitPrice(
  extendedValue: string | number | null | undefined,
  quantity: number,
): number {
  const ext = Number(extendedValue);
  const q = normalizeUnitCount(quantity);
  if (!Number.isFinite(ext) || ext <= 0) return 0;
  return Math.round((ext / q) * 100) / 100;
}

export interface ExistingSaleRow {
  id: string;
  line_item_id: string | null;
}

/**
 * Choose which existing sale row (already fetched for this item+order) a given
 * line item should update — or null to insert a fresh row — so distinct line
 * items of the SAME inventory item in ONE order don't collapse onto one row.
 *
 *  1. A row whose line_item_id already equals this line's id → update it
 *     (idempotent re-sync of the same line).
 *  2. This line has no id (manual/edge) and a row with no id exists → update it.
 *  3. A legacy row with no line_item_id exists (written by the pre-migration
 *     sync, which kept at most one row per item+order) → adopt it ONCE, stamping
 *     this line's id on update so the NEXT line in the same order gets its own
 *     row on the next pass. Disable with { adoptLegacy: false }.
 *  4. Otherwise → null (insert).
 *
 * Callers re-query `existing` per line item, so adoption is naturally
 * sequential: once a legacy row is stamped with line A's id, line B no longer
 * sees an empty-id row and inserts its own.
 */
export function pickSaleRowForLine(
  existing: ExistingSaleRow[],
  lineItemId: string | null,
  opts: { adoptLegacy?: boolean } = {},
): ExistingSaleRow | null {
  const wanted = (lineItemId ?? "").trim();

  if (wanted !== "") {
    const exact = existing.find((r) => (r.line_item_id ?? "").trim() === wanted);
    if (exact) return exact;
  } else {
    const emptyRow = existing.find((r) => (r.line_item_id ?? "").trim() === "");
    if (emptyRow) return emptyRow;
  }

  if (opts.adoptLegacy ?? true) {
    const legacy = existing.find((r) => (r.line_item_id ?? "").trim() === "");
    if (legacy) return legacy;
  }

  return null;
}
