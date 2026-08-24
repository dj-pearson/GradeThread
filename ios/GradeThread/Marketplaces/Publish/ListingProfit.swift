import Foundation
import GradeThreadCore

/// Forward-looking profit/margin estimate for a listing at a given price, so
/// pricing is a margin decision instead of a guess. Mirrors the web
/// `estimateListingProfit` (`src/lib/listing-profit.ts`) field-for-field —
/// same eBay Managed Payments model: a final-value-fee fraction (13.6%, which
/// already folds in payment processing) plus a fixed per-order fee.
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

    /// ⚠ CORRECTED (US-2840), from 0.1325 to 0.136. Web moved in US-9003 and iOS did
    /// not, so this app spent that whole time promising sellers 0.35 points
    /// more than eBay leaves them, on every item, in the one place the money
    /// actually leaves their hand. 13.25% is a real eBay rate -- it belongs to
    /// Coins & Paper Money and the trading-card categories. Apparel is "Most
    /// categories" at 13.6%, verified against eBay id=4822.
    ///
    /// The authority is `src/lib/ebay-fees.ts` (mirrored into the edge). When
    /// eBay moves the rate again, that file moves first and this follows.
    public static let defaultFeeRate = 0.136
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

extension ListingProfit {
    /// US-1512: estimated Promoted Listings ad fee at `ratePct` percent of the
    /// price. eBay charges this ONLY when the sale is attributed to the ad, so
    /// it is surfaced as a separate labeled line under the estimate rather than
    /// folded into `net` — the net stays a field-for-field mirror of the web
    /// `estimateListingProfit` (which likewise excludes the conditional ad fee).
    public static func promotedAdFee(price: Double, ratePct: Double) -> Double {
        max(0, price) * max(0, ratePct) / 100
    }
}

/// US-1512: composer-side helpers for the Promoted Listings ad rate — the same
/// bounds the edge enforces (`ebay-marketing.ts` MIN/MAX_AD_RATE_PCT), so the
/// number the seller sees is the number the server will apply.
enum PromotedAdRate {
    static let minPct = 2.0
    static let maxPct = 20.0

    static func clamp(_ pct: Double) -> Double {
        guard pct.isFinite else { return minPct }
        return min(maxPct, max(minPct, pct))
    }

    /// Locale-tolerant parse of the composer's rate text ("8", "8.5", "8,5",
    /// "8%"). nil when blank/unparseable/non-positive — the server then falls
    /// back to the category suggestion (same contract as the web composer's
    /// blank rate box).
    static func parse(_ text: String) -> Double? {
        let cleaned = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "%", with: "")
            .replacingOccurrences(of: ",", with: ".")
        guard let value = Double(cleaned), value > 0 else { return nil }
        return clamp(value)
    }

    /// "8" / "8.5" — eBay bids carry at most one decimal, and a bare integer
    /// shouldn't render ".0" noise.
    static func format(_ pct: Double) -> String {
        let value = clamp(pct)
        return value == value.rounded()
            ? String(Int(value))
            : String(format: "%.1f", value)
    }
}

extension ListingProfit {
    /// `net` rounded to whole cents through ``Money`` — the SAME rounding the
    /// Money tab applies to each completed sale's realized P&L (`Money.sum` over
    /// `SalePnL.net`). The composer displays THIS, not the raw `net`, so its
    /// estimate matches the Money tab's net for an equivalent completed sale to
    /// the cent (the raw `net` stays a faithful mirror of the web
    /// `estimateListingProfit`; only the display boundary rounds).
    var netCents: Double { Money.cents(net) }

    /// `fees` rounded to whole cents for display alongside ``netCents``.
    var feesCents: Double { Money.cents(fees) }

    /// Margin recomputed from the cents-exact ``netCents`` so the shown "% margin"
    /// agrees with the shown net (0 when there's no price to divide by).
    func marginPctCents(price: Double) -> Double {
        let p = Money.cents(price)
        return p > 0 ? (netCents / p) * 100 : 0
    }
}
