import type { SaleRow } from "@/types/database";

export interface Pnl {
  revenue: number; // sale_price + shipping_collected
  fees: number; // platform + payment processing
  costs: number; // shipping + grading + other (NOT tax — see below)
  costBasis: number; // item acquisition cost
  net: number; // revenue − fees − costs − costBasis
  marginPct: number | null; // net / sale_price
}

// Live P&L from a sale row + the item's acquisition cost. Computed rather
// than trusting the stored net_profit column, so it always reflects edits.
//
// Sales tax is intentionally EXCLUDED from both revenue and costs: on eBay
// (Marketplace Facilitator) the tax is collected from the buyer and remitted
// to the government by the marketplace — it is neither the seller's income nor
// the seller's expense. This matches the eBay sync's stored net_profit formula
// (flipdesk-ebay.ts) so the live calc and the persisted column agree.
export function computePnl(sale: SaleRow, costBasis: number | null): Pnl {
  const cb = costBasis ?? 0;
  const revenue = (sale.sale_price ?? 0) + (sale.shipping_collected ?? 0);
  const fees =
    (sale.platform_fees ?? 0) + (sale.payment_processing_fees ?? 0);
  const costs =
    (sale.shipping_cost ?? 0) +
    (sale.grading_cost ?? 0) +
    (sale.other_costs ?? 0);
  const net = revenue - fees - costs - cb;
  const marginPct =
    sale.sale_price && sale.sale_price > 0
      ? (net / sale.sale_price) * 100
      : null;
  return { revenue, fees, costs, costBasis: cb, net, marginPct };
}

// Flag fee/shipping anomalies worth a human look.
export function detectDiscrepancies(sale: SaleRow): string[] {
  const out: string[] = [];
  const price = sale.sale_price ?? 0;
  if (price > 0 && (sale.platform_fees ?? 0) > price * 0.15) {
    out.push(
      `Marketplace fees ($${(sale.platform_fees ?? 0).toFixed(2)}) exceed 15% of the sale price.`,
    );
  }
  if ((sale.shipping_cost ?? 0) > (sale.shipping_collected ?? 0) + 2) {
    out.push(
      `Shipping cost ($${(sale.shipping_cost ?? 0).toFixed(2)}) is more than $2 over what the buyer paid ($${(sale.shipping_collected ?? 0).toFixed(2)}).`,
    );
  }
  return out;
}
