// Pure scoring helpers for payout↔sale reconciliation (US-461).
//
// Kept dependency-free (no hono / no supabase) so the candidate-net math is
// unit-testable in isolation and can't drift from the route handler that uses
// it (services/edge-functions/src/routes/flipdesk-reconciliation.ts).

/** The sale fields the net estimate reads. */
export interface SaleNetInput {
  sale_price: number | null;
  payout_amount: number | null;
  platform_fees: number | null;
  shipping_collected: number | null;
  /** Shipping label cost — deducted from eBay payouts when bought via eBay. */
  shipping_cost: number | null;
  payment_processing_fees: number | null;
}

/**
 * Estimate the net amount eBay actually pays out for a sale.
 *
 * Prefer the ENRICHED `payout_amount` (ground truth from the eBay finances
 * feed). Otherwise estimate from the sale's own fields. The estimate accounts
 * for the shipping LABEL cost (deducted from eBay payouts when the seller buys
 * the label through eBay) and the buyer-paid shipping that eBay adds to the
 * payout — both of which the old `sale_price - platform_fees` ignored, so it
 * systematically over-estimated the net and mis-scored free-shipping sales.
 *
 * Returns `{ net, estimated }` so callers can flag (rather than silently trust)
 * an estimate when no enriched payout figure exists yet.
 */
export function saleNetEstimate(
  sale: SaleNetInput,
): { net: number | null; estimated: boolean } {
  if (sale.payout_amount != null) {
    return { net: sale.payout_amount, estimated: false };
  }
  if (sale.sale_price == null) return { net: null, estimated: true };
  const net =
    sale.sale_price +
    (sale.shipping_collected ?? 0) -
    (sale.platform_fees ?? 0) -
    (sale.shipping_cost ?? 0) -
    (sale.payment_processing_fees ?? 0);
  return { net, estimated: true };
}
