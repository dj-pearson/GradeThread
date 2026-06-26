import type { SaleRow } from "@/types/database";
import { computePnl } from "@/lib/pnl";
import { escapeCsvCell } from "@/lib/items-csv";

// US-1291: tax-ready P&L / COGS export for FlipDesk reconciliation.
//
// This module is the PRESENTATION layer only — it never invents a number.
// Every per-item row is built straight from the canonical per-item P&L
// (`computePnl`, lib/pnl.ts), so the export can never drift from what the P&L
// panel shows the seller. The period totals are a plain sum over those rows,
// so the summary always reconciles to the underlying sales rows to the penny.
//
// Pure (no React / supabase) so it unit-tests directly and can be reused by a
// printable view and the CSV builder alike.

const UNCATEGORIZED = "Uncategorized";
const NO_BRAND = "No brand";

export interface TaxPnlItemMeta {
  title: string;
  category: string | null;
  brand: string | null;
  /** Source/acquisition cost = COGS. */
  costBasis: number | null;
}

export interface TaxPnlFilters {
  /** Exact category match; null/empty = all categories. */
  category?: string | null;
  /** Exact brand match; null/empty = all brands. */
  brand?: string | null;
  /** yyyy-mm-dd inclusive lower bound on the sale date. */
  startDate?: string | null;
  /** yyyy-mm-dd inclusive upper bound on the sale date. */
  endDate?: string | null;
}

export interface TaxPnlRow {
  saleId: string;
  itemId: string;
  /** yyyy-mm-dd (date-only; eBay/manual sales are date-keyed). */
  saleDate: string;
  title: string;
  category: string;
  brand: string;
  salePrice: number;
  shippingCollected: number;
  /** sale price + shipping collected. */
  revenue: number;
  /** Cost of goods sold = the item's source/acquisition cost. */
  cogs: number;
  /** Marketplace + payment-processing fees. */
  fees: number;
  shippingCost: number;
  gradingCost: number;
  otherCosts: number;
  /** revenue − fees − (shipping + grading + other) − COGS. Equals computePnl().net. */
  net: number;
}

export interface TaxPnlTotals {
  count: number;
  revenue: number;
  cogs: number;
  fees: number;
  shippingCost: number;
  gradingCost: number;
  otherCosts: number;
  net: number;
}

// Date-only key for filtering/grouping. ISO timestamps and date-only strings
// both slice cleanly to yyyy-mm-dd, which compares lexicographically — no
// Date parsing, so no timezone drift (cf. dayStartMs in item-filter.ts).
function saleDateKey(sale: SaleRow): string {
  return (sale.sale_date ?? "").slice(0, 10);
}

// One tax-export row built straight from the canonical per-item P&L so the
// export can never drift from the P&L panel. Net is taken verbatim from
// computePnl; the broken-out cost columns sum back to it by construction.
export function buildTaxPnlRow(
  sale: SaleRow,
  meta: TaxPnlItemMeta | undefined,
): TaxPnlRow {
  const pnl = computePnl(sale, meta?.costBasis ?? null);
  return {
    saleId: sale.id,
    itemId: sale.inventory_item_id,
    saleDate: saleDateKey(sale),
    title: meta?.title?.trim() || sale.inventory_item_id,
    category: meta?.category?.trim() || UNCATEGORIZED,
    brand: meta?.brand?.trim() || NO_BRAND,
    salePrice: sale.sale_price ?? 0,
    shippingCollected: sale.shipping_collected ?? 0,
    revenue: pnl.revenue,
    cogs: pnl.costBasis,
    fees: pnl.fees,
    shippingCost: sale.shipping_cost ?? 0,
    gradingCost: sale.grading_cost ?? 0,
    otherCosts: sale.other_costs ?? 0,
    net: pnl.net,
  };
}

// Build the filtered per-item P&L rows. Only realized ('completed') sales count
// toward P&L — same rule the analytics/finances surfaces use — so cancelled or
// refunded orders never inflate a tax report.
export function buildTaxPnlRows(
  sales: SaleRow[],
  metaById: Map<string, TaxPnlItemMeta>,
  filters: TaxPnlFilters = {},
): TaxPnlRow[] {
  const category = filters.category?.trim() || null;
  const brand = filters.brand?.trim() || null;
  const start = filters.startDate || null;
  const end = filters.endDate || null;

  return sales
    .filter((s) => s.status === "completed")
    .map((s) => buildTaxPnlRow(s, metaById.get(s.inventory_item_id)))
    .filter((r) => {
      if (category && r.category !== category) return false;
      if (brand && r.brand !== brand) return false;
      if (start && (!r.saleDate || r.saleDate < start)) return false;
      if (end && (!r.saleDate || r.saleDate > end)) return false;
      return true;
    })
    .sort((a, b) => a.saleDate.localeCompare(b.saleDate));
}

// Period totals = plain sum over the rows, so the summary always reconciles to
// the per-item P&L (and therefore to the underlying sales rows).
export function sumTaxPnl(rows: TaxPnlRow[]): TaxPnlTotals {
  const t: TaxPnlTotals = {
    count: 0,
    revenue: 0,
    cogs: 0,
    fees: 0,
    shippingCost: 0,
    gradingCost: 0,
    otherCosts: 0,
    net: 0,
  };
  for (const r of rows) {
    t.count += 1;
    t.revenue += r.revenue;
    t.cogs += r.cogs;
    t.fees += r.fees;
    t.shippingCost += r.shippingCost;
    t.gradingCost += r.gradingCost;
    t.otherCosts += r.otherCosts;
    t.net += r.net;
  }
  return t;
}

// Distinct category / brand values present in the rows, for the filter
// dropdowns. Build these from the UNfiltered rows so options never vanish.
export function distinctValues(
  rows: TaxPnlRow[],
  key: "category" | "brand",
): string[] {
  return [...new Set(rows.map((r) => r[key]))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export const TAX_PNL_HEADERS = [
  "Sale Date",
  "Item",
  "Category",
  "Brand",
  "Sale Price",
  "Shipping Collected",
  "Gross Revenue",
  "COGS (Source Cost)",
  "Marketplace Fees",
  "Shipping Cost",
  "Grading Cost",
  "Other Costs",
  "Net Profit",
] as const;

// Per-item detail rows aligned to TAX_PNL_HEADERS, money formatted to 2dp.
export function taxPnlCsvRows(rows: TaxPnlRow[]): string[][] {
  return rows.map((r) => [
    r.saleDate,
    r.title,
    r.category,
    r.brand,
    r.salePrice.toFixed(2),
    r.shippingCollected.toFixed(2),
    r.revenue.toFixed(2),
    r.cogs.toFixed(2),
    r.fees.toFixed(2),
    r.shippingCost.toFixed(2),
    r.gradingCost.toFixed(2),
    r.otherCosts.toFixed(2),
    r.net.toFixed(2),
  ]);
}

// Full tax-ready CSV: a summary block (period totals) followed by the per-item
// detail. The summary mirrors the totals an accountant files; the detail backs
// every line. Reuses the inventory CSV escaping so it round-trips through
// Excel / Google Sheets.
export function taxPnlCsvText(
  rows: TaxPnlRow[],
  totals: TaxPnlTotals,
): string {
  const lines: string[] = [];
  lines.push("TAX-READY P&L SUMMARY");
  lines.push(`Sales,${totals.count}`);
  lines.push(`Gross Revenue,${totals.revenue.toFixed(2)}`);
  lines.push(`COGS (Source Cost),${totals.cogs.toFixed(2)}`);
  lines.push(`Marketplace Fees,${totals.fees.toFixed(2)}`);
  lines.push(`Shipping Cost,${totals.shippingCost.toFixed(2)}`);
  lines.push(`Grading Cost,${totals.gradingCost.toFixed(2)}`);
  lines.push(`Other Costs,${totals.otherCosts.toFixed(2)}`);
  lines.push(`Net Profit,${totals.net.toFixed(2)}`);
  lines.push("");
  lines.push("PER-ITEM DETAIL");
  lines.push(TAX_PNL_HEADERS.map((h) => escapeCsvCell(h)).join(","));
  for (const row of taxPnlCsvRows(rows)) {
    lines.push(row.map((c) => escapeCsvCell(c)).join(","));
  }
  return lines.join("\n");
}
