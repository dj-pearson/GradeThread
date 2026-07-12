import Foundation

/// The per-sale money fields ``SalePnL`` needs — decoupled from the app's
/// SwiftData `LocalSale` `@Model` so the profit math can live in GradeThreadCore
/// and be unit-tested on Linux (`swift test`, no Mac). `LocalSale` conforms to
/// this in the app (its stored properties already match, so the conformance is a
/// one-line empty extension) — one P&L definition, no duplication.
public protocol SaleFinancials {
    /// Lifecycle status; `""`/`"completed"` count, cancelled/refunded don't.
    var status: String { get }
    var salePrice: Double { get }
    var shippingCollected: Double? { get }
    var platformFees: Double { get }
    var paymentProcessingFees: Double? { get }
    var shippingCost: Double? { get }
    var gradingCost: Double? { get }
    var otherCosts: Double? { get }
}

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
public enum SalePnL {
    /// True when this sale should count toward revenue/profit/sold totals.
    /// Cancelled / refunded orders are excluded. Unknown/empty status is
    /// treated as completed (legacy rows predate the status column).
    public static func isCompleted<S: SaleFinancials>(_ sale: S) -> Bool {
        sale.status.isEmpty || sale.status == "completed"
    }

    public static func revenue<S: SaleFinancials>(_ sale: S) -> Double {
        sale.salePrice + (sale.shippingCollected ?? 0)
    }

    public static func fees<S: SaleFinancials>(_ sale: S) -> Double {
        sale.platformFees + (sale.paymentProcessingFees ?? 0)
    }

    public static func sellerCosts<S: SaleFinancials>(_ sale: S) -> Double {
        (sale.shippingCost ?? 0) + (sale.gradingCost ?? 0) + (sale.otherCosts ?? 0)
    }

    /// Net profit for one sale given the item's cost basis (acquisition price).
    public static func net<S: SaleFinancials>(_ sale: S, costBasis: Double) -> Double {
        revenue(sale) - fees(sale) - sellerCosts(sale) - costBasis
    }
}
