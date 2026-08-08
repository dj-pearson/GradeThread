import { csvBlob, downloadBlob } from "@/lib/download";
import type { ItemFullRow } from "@/types/database";

// US-1636: neutralize CSV / spreadsheet formula injection. Excel & Google
// Sheets execute a cell whose text begins with = + - @ (or a leading tab / CR),
// so a marketplace-sourced title/category/platform like `=HYPERLINK(...)` or
// `=cmd|...` would run on open. Prefix such a cell with an apostrophe so the
// spreadsheet treats it as literal text. Genuine numeric values (including
// negative amounts like -5.00) are left intact so money columns still compute.
function neutralizeCsvFormula(s: string): string {
  if (s === "") return s;
  if (/^[=+\-@\t\r]/.test(s) && !isPlainNumber(s)) return `'${s}`;
  return s;
}

function isPlainNumber(s: string): boolean {
  const t = s.trim();
  return t !== "" && Number.isFinite(Number(t));
}

// Escapes a single CSV cell. Neutralizes formula-injection first, then wraps in
// quotes only when the value contains a comma, quote, or newline — keeps clean
// values un-quoted for readability when the file is opened in Excel or Sheets.
export function escapeCsvCell(value: unknown): string {
  if (value == null) return "";
  const s = neutralizeCsvFormula(String(value));
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Triggers a browser download of the given rows as a CSV. Columns match
// what the user's eBay Sheet expects so the file round-trips cleanly.
export function downloadItemsCsv(rows: ItemFullRow[]): void {
  const headers = [
    "Container",
    "Item #",
    "Item Title",
    "Item Description",
    "Brand",
    "Style",
    "Size",
    "Notes",
    "Category",
    "Source",
    "Sourced By",
    "Purchase Date",
    "Purchase Price",
    "List Date",
    "Link",
    "List Price",
    "Sale Date",
    "Sale Price",
    "Fees",
    "Tax",
    "Shipping Cost",
    "Net Profit",
    "Payout",
    "Status",
    "Days to Sell",
    "Tracking",
  ];
  const lines = [headers.map(escapeCsvCell).join(",")];

  // Stable, human-friendly order: numbered items ascending by Item # (SKU),
  // then un-numbered items (drafts) alphabetically by title — instead of the
  // arbitrary view order, which interleaves drafts and listed items.
  const sorted = [...rows].sort((a, b) => {
    const na = Number(a.item_number);
    const nb = Number(b.item_number);
    const aNum = a.item_number != null && a.item_number !== "" && Number.isFinite(na);
    const bNum = b.item_number != null && b.item_number !== "" && Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum) return -1;
    if (bNum) return 1;
    return (a.item_title ?? "").localeCompare(b.item_title ?? "");
  });

  for (const r of sorted) {
    // Sale-only money columns are blank until the item actually sells. The
    // items_full view computes fees as COALESCE(platform_fees,0)+COALESCE(
    // processing,0), so an UNSOLD item reads 0 — which looks like a real $0 fee
    // in the sheet. Gate every sale-derived column on the presence of a sale.
    const sold = r.sale_date != null || r.sale_price != null;
    lines.push(
      [
        r.container,
        r.item_number,
        r.item_title,
        r.item_description,
        r.brand,
        r.style,
        r.size,
        r.notes,
        r.category,
        r.source_name,
        r.sourced_by,
        r.purchase_date?.slice(0, 10),
        r.purchase_price,
        r.list_date?.slice(0, 10),
        r.link,
        r.list_price,
        r.sale_date?.slice(0, 10),
        r.sale_price,
        sold ? r.fees : null,
        sold ? r.tax : null,
        sold ? r.shipping_cost : null,
        sold ? r.net_profit : null,
        sold ? r.payout : null,
        r.status,
        r.days_to_sell,
        r.tracking,
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }
  const ts = new Date().toISOString().slice(0, 10);
  downloadBlob(csvBlob(lines.join("\n")), `flipdesk-items-${ts}.csv`);
}
