import type { ItemFullRow } from "@/types/database";

// Escapes a single CSV cell. Wraps in quotes only when the value contains
// a comma, quote, or newline — keeps clean values un-quoted for readability
// when the file is opened in Excel or Sheets.
export function escapeCsvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
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
  for (const r of rows) {
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
        r.fees,
        r.tax,
        r.shipping_cost,
        r.net_profit,
        r.payout,
        r.status,
        r.days_to_sell,
        r.tracking,
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().slice(0, 10);
  a.download = `flipdesk-items-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
