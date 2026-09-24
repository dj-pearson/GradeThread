import type { SaleRow } from "@/types/database";
import {
  MARKETPLACE_FEES,
  quoteMarketplace,
  type MarketplaceKey,
} from "@/lib/marketplace-fee-schedules";

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

/** A marketplace charged more than its own published schedule says. */
export interface FeeDiscrepancy {
  /** What the platform's schedule says the fees should be. */
  expected: number;
  /** What the sale row says was charged (selling + processing fees). */
  charged: number;
  /** charged - expected, always positive when returned. */
  overBy: number;
}

/** Over by more than this is a red "look now"; under it is an amber check. */
export const FEE_GAP_RED = 5;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The platform a sale happened on, when it can be known: the marketplace's own
 * order reference first, then the item's listing. Null when neither names a
 * platform whose fee schedule we have, and the fee rule is then skipped rather
 * than guessed.
 */
export function salePlatform(
  sale: Pick<SaleRow, "platform_order_ref">,
  listingPlatform?: string | null,
): MarketplaceKey | null {
  const fromRef = sale.platform_order_ref?.["platform"];
  const candidate =
    typeof fromRef === "string" && fromRef ? fromRef : (listingPlatform ?? null);
  if (!candidate) return null;
  const key = candidate.toLowerCase();
  return key in MARKETPLACE_FEES ? (key as MarketplaceKey) : null;
}

/**
 * Compares what a completed sale was charged with what its marketplace's own
 * fee schedule says (eBay through its full calculator, the rest through
 * MARKETPLACE_FEES). Flags only a real overcharge: more than $1 or 10% of the
 * expected fee, whichever is larger. A flat 15% line used to flag every normal
 * Poshmark sale (20%) and small eBay sales (the $0.40 order fee) as errors.
 */
export function detectFeeDiscrepancy(
  sale: SaleRow,
  platform: MarketplaceKey | null,
): FeeDiscrepancy | null {
  if (sale.status !== "completed" || !platform) return null;
  const price = sale.sale_price ?? 0;
  if (price <= 0) return null;
  const quote = quoteMarketplace(platform, {
    itemPrice: price,
    shippingCharged: sale.shipping_collected ?? 0,
    salesTax: sale.tax ?? 0,
  });
  const expected = round2(quote.totalFees);
  const charged = round2(
    (sale.platform_fees ?? 0) + (sale.payment_processing_fees ?? 0),
  );
  const overBy = round2(charged - expected);
  if (overBy <= Math.max(1, expected * 0.1)) return null;
  return { expected, charged, overBy };
}

// Flag fee/shipping anomalies worth a human look. Only completed sales: a
// cancelled or refunded sale's fees are credited back on their own schedule.
export function detectDiscrepancies(
  sale: SaleRow,
  platform: MarketplaceKey | null = null,
): string[] {
  const out: string[] = [];
  if (sale.status !== "completed") return out;
  const fee = detectFeeDiscrepancy(sale, platform);
  if (fee) {
    out.push(
      `Charged $${fee.charged.toFixed(2)} in fees, expected about $${fee.expected.toFixed(2)} on ${MARKETPLACE_FEES[platform!].name}'s schedule.`,
    );
  }
  if ((sale.shipping_cost ?? 0) > (sale.shipping_collected ?? 0) + 2) {
    out.push(
      `Shipping cost ($${(sale.shipping_cost ?? 0).toFixed(2)}) is more than $2 over what the buyer paid ($${(sale.shipping_collected ?? 0).toFixed(2)}).`,
    );
  }
  return out;
}
