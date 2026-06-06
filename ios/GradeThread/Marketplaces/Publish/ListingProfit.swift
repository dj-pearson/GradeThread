import Foundation

/// Forward-looking profit/margin estimate for a listing at a given price, so
/// pricing is a margin decision instead of a guess. Mirrors the web
/// `estimateListingProfit` (`src/lib/listing-profit.ts`) field-for-field —
/// same eBay Managed Payments model: a final-value-fee fraction (~13.25%,
/// which already folds in payment processing) plus a fixed per-order fee.
///
/// Pure value type so the math is unit-tested without any view plumbing.
public struct ListingProfit: Equatable {
    /// Estimated marketplace fees (FVF + fixed).
    public let fees: Double
    /// Your costs: cost basis + grading + shipping.
    public let costs: Double
    /// price − fees − costs (can be negative).
    public let net: Double
    /// net / price * 100; 0 when price is 0.
    public let marginPct: Double

    public static let defaultFeeRate = 0.1325
    public static let defaultFixedFee = 0.40

    /// Estimates fees/costs/net/margin for `price`. `costBasis`, `gradingCost`
    /// and `shippingCost` are clamped to ≥ 0 and treated as 0 when nil (the
    /// margin then reflects revenue-after-fees only — matching the web).
    public static func estimate(
        price: Double,
        costBasis: Double? = nil,
        gradingCost: Double? = nil,
        shippingCost: Double? = nil,
        feeRate: Double = defaultFeeRate,
        fixedFee: Double = defaultFixedFee
    ) -> ListingProfit {
        let price = max(0, price)
        let cost = max(0, costBasis ?? 0)
        let grading = max(0, gradingCost ?? 0)
        let shipping = max(0, shippingCost ?? 0)

        let fees = price > 0 ? price * feeRate + fixedFee : 0
        let costs = cost + grading + shipping
        let net = price - fees - costs
        let marginPct = price > 0 ? (net / price) * 100 : 0
        return ListingProfit(fees: fees, costs: costs, net: net, marginPct: marginPct)
    }
}
