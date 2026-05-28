import { escapeCsvCell } from "@/lib/items-csv";
import type { SaleRow, ExpenseRow } from "@/types/database";
import { EXPENSE_CATEGORY_LABELS } from "@/lib/constants";

// Generic CSV download. `rows` is an array of cell arrays already aligned to
// `headers`. Reuses the same escaping rules as the inventory export so all
// FlipDesk CSVs round-trip cleanly through Excel / Google Sheets.
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: unknown[][],
): void {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(","));
  }
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function isoDate(d: string | null | undefined): string {
  return d ? d.slice(0, 10) : "";
}

// Sales / financials export — one row per sale with the full fee breakdown.
// Aimed at bookkeeping/tax: gross, fees, shipping, costs, net. `titleById`
// supplies the item title from the items_full cache (sales rows only carry
// inventory_item_id).
export function downloadSalesCsv(
  sales: SaleRow[],
  titleById?: Map<string, string>,
): void {
  const headers = [
    "Sale Date",
    "Item",
    "Buyer",
    "Sale Price",
    "Shipping Collected",
    "Tax",
    "Platform Fees",
    "Payment Processing",
    "Shipping Cost",
    "Grading Cost",
    "Other Costs",
    "Net Profit",
    "Payout Amount",
    "Payout Reference",
    "Tracking",
    "Shipped At",
  ];
  const rows = sales.map((s) => [
    isoDate(s.sale_date),
    titleById?.get(s.inventory_item_id) ?? s.inventory_item_id,
    s.buyer_username,
    s.sale_price,
    s.shipping_collected,
    s.tax,
    s.platform_fees,
    s.payment_processing_fees,
    s.shipping_cost,
    s.grading_cost,
    s.other_costs,
    s.net_profit,
    s.payout_amount,
    s.payout_reference,
    s.tracking_number,
    isoDate(s.shipped_at),
  ]);
  const ts = new Date().toISOString().slice(0, 10);
  downloadCsv(`flipdesk-sales-${ts}.csv`, headers, rows);
}

// Operating-expenses export — one row per logged expense.
export function downloadExpensesCsv(expenses: ExpenseRow[]): void {
  const headers = ["Date", "Category", "Description", "Amount"];
  const rows = expenses.map((e) => [
    isoDate(e.spent_on),
    EXPENSE_CATEGORY_LABELS[e.category] ?? e.category,
    e.description,
    e.amount,
  ]);
  const ts = new Date().toISOString().slice(0, 10);
  downloadCsv(`flipdesk-expenses-${ts}.csv`, headers, rows);
}
