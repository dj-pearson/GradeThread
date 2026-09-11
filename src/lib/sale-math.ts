// The net-profit preview in the Record Sale dialog (US-3367).
//
// The edge writes the real number (services/edge-functions/src/lib/record-sale.ts)
// with the same expression; src/lib/__tests__/sale-math.test.ts pins the two by
// source so a change to one without the other fails the build.
export interface SaleMoney {
  sale_price: number;
  shipping_collected: number;
  platform_fees: number;
  payment_processing_fees: number;
  shipping_cost: number;
  tax: number;
  other_costs: number;
}

export function computeNetProfit(i: SaleMoney, purchasePrice: number): number {
  return i.sale_price + i.shipping_collected - i.platform_fees -
    i.payment_processing_fees - i.shipping_cost - i.tax - i.other_costs - purchasePrice;
}
