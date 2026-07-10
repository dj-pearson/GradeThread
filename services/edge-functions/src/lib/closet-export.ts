// US-1828: closet insurance export (CSV) + closet→inventory promotion mapping.
// PURE (unit-tested, no DB / no network).

const CERT_BASE = "https://gradethread.com/cert/";

/** RFC-4180 CSV cell: quote when it contains a comma/quote/newline; double quotes. */
export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ClosetExportRow {
  brand: string | null;
  garment_type: string | null;
  size: string | null;
  condition_grade: number | null;
  certificate_id: string | null;
  estimateCents: number | null;
  costBasisCents: number | null;
}

const dollars = (cents: number | null): string => (cents == null ? "" : (cents / 100).toFixed(2));

/**
 * Build an insurance-ready CSV of owned items: identity + certified grade +
 * current estimated value + cost basis. A stable header row + one row per item.
 * Values are labeled estimates (the header says so); never fabricated precision.
 */
export function buildClosetCsv(rows: ClosetExportRow[]): string {
  const header = [
    "Brand",
    "Item",
    "Size",
    "Certified Grade",
    "Certificate",
    "Estimated Value (USD)",
    "Cost Basis (USD)",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.brand ?? ""),
        csvCell(r.garment_type ?? ""),
        csvCell(r.size ?? ""),
        csvCell(r.condition_grade != null ? r.condition_grade.toFixed(1) : ""),
        csvCell(r.certificate_id ? `${CERT_BASE}${r.certificate_id}` : ""),
        csvCell(dollars(r.estimateCents)),
        csvCell(dollars(r.costBasisCents)),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// ── closet → inventory promotion mapping ────────────────────────────────────

export interface ClosetItemForPromotion {
  brand: string | null;
  garment_type: string | null;
  size: string | null;
  condition_grade: number | null;
  certificate_id: string | null;
  title: string | null;
  notes: string | null;
}

export interface InventoryDraft {
  title: string;
  brand: string | null;
  size: string | null;
  item_category: "clothing";
  grade_value: number | null;
  certificate_url: string | null;
  status: "cataloged";
  listing_price: number;
  condition_notes: string | null;
  notes: string;
}

/**
 * Pre-fill a FlipDesk inventory draft from a closet item + its valuation estimate.
 * PURE. The suggested listing_price is the current estimate in dollars (0 when we
 * have no estimate — the seller sets the real price); the cert URL carries the
 * grade + graded photos through. garment_type stays in the title because the
 * closet's free-text type doesn't map to inventory's garment_type enum.
 */
export function inventoryFromCloset(item: ClosetItemForPromotion, estimateCents: number | null): InventoryDraft {
  const title = (item.title?.trim()) ||
    [item.brand, item.garment_type].filter(Boolean).join(" ").trim() ||
    "Wardrobe item";
  return {
    title,
    brand: item.brand,
    size: item.size,
    item_category: "clothing",
    grade_value: item.condition_grade,
    certificate_url: item.certificate_id ? `${CERT_BASE}${item.certificate_id}` : null,
    status: "cataloged",
    listing_price: estimateCents != null && estimateCents > 0 ? Math.round(estimateCents) / 100 : 0,
    condition_notes: item.notes,
    notes: "Promoted from closet portfolio (US-1828).",
  };
}
