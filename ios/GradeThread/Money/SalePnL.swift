import Foundation

/// Single source of truth for per-sale profit math on iOS — the mirror of the
/// web `src/lib/pnl.ts` `computePnl`. Every rollup (Dashboard, Money, Analytics)
/// MUST net profit through here so the three surfaces, and the web, agree.
///
/// Definition (matches the eBay sync's stored net_profit):
///   revenue = sale_price + shipping_collected
///   fees    = platform_fees + payment_processing_fees
///   costs   = shipping_cost + grading_cost + other_costs   (NOT tax)
///   net     = revenue − fees − costs − cost_basis
///
/// Sales tax is pass-through on a marketplace (collected from the buyer,
/// remitted by eBay) so it is neither revenue nor cost.
enum SalePnL {
    /// True when this sale should count toward revenue/profit/sold totals.
    /// Cancelled / refunded orders are excluded. Unknown/empty status is
    /// treated as completed (legacy rows predate the status column).
    static func isCompleted(_ sale: LocalSale) -> Bool {
        sale.status.isEmpty || sale.status == "completed"
    }

    static func revenue(_ sale: LocalSale) -> Double {
        sale.salePrice + (sale.shippingCollected ?? 0)
    }

    static func fees(_ sale: LocalSale) -> Double {
        sale.platformFees + (sale.paymentProcessingFees ?? 0)
    }

    static func sellerCosts(_ sale: LocalSale) -> Double {
        (sale.shippingCost ?? 0) + (sale.gradingCost ?? 0) + (sale.otherCosts ?? 0)
    }

    /// Net profit for one sale given the item's cost basis (acquisition price).
    static func net(_ sale: LocalSale, costBasis: Double) -> Double {
        revenue(sale) - fees(sale) - sellerCosts(sale) - costBasis
    }
}
