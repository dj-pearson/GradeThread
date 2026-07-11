import XCTest
@testable import GradeThreadCore

/// Per-sale P&L math, now tested on Linux via a plain `SaleFinancials` value —
/// no SwiftData `LocalSale`, no simulator. This is the payoff of the protocol
/// decoupling: the money source-of-truth runs in `swift test`.
final class SalePnLTests: XCTestCase {

    /// Minimal stand-in for a sale row.
    private struct Sale: SaleFinancials {
        var status: String = "completed"
        var salePrice: Double = 0
        var shippingCollected: Double? = nil
        var platformFees: Double = 0
        var paymentProcessingFees: Double? = nil
        var shippingCost: Double? = nil
        var gradingCost: Double? = nil
        var otherCosts: Double? = nil
    }

    func test_isCompleted_treatsEmptyAndCompletedAsCounted() {
        XCTAssertTrue(SalePnL.isCompleted(Sale(status: "")))
        XCTAssertTrue(SalePnL.isCompleted(Sale(status: "completed")))
        XCTAssertFalse(SalePnL.isCompleted(Sale(status: "refunded")))
        XCTAssertFalse(SalePnL.isCompleted(Sale(status: "cancelled")))
    }

    func test_revenue_addsShippingCollected() {
        XCTAssertEqual(SalePnL.revenue(Sale(salePrice: 50, shippingCollected: 8)), 58, accuracy: 0.0001)
        XCTAssertEqual(SalePnL.revenue(Sale(salePrice: 50)), 50, accuracy: 0.0001) // nil shipping → 0
    }

    func test_fees_sumPlatformAndProcessing() {
        XCTAssertEqual(
            SalePnL.fees(Sale(platformFees: 5, paymentProcessingFees: 1.5)), 6.5, accuracy: 0.0001)
        XCTAssertEqual(SalePnL.fees(Sale(platformFees: 5)), 5, accuracy: 0.0001)
    }

    func test_sellerCosts_sumShippingGradingOther() {
        let s = Sale(shippingCost: 4, gradingCost: 2, otherCosts: 1)
        XCTAssertEqual(SalePnL.sellerCosts(s), 7, accuracy: 0.0001)
    }

    func test_net_isRevenueMinusFeesCostsAndBasis_taxExcluded() {
        // revenue 58 − fees 6.5 − sellerCosts 7 − basis 10 = 34.5
        let s = Sale(
            salePrice: 50, shippingCollected: 8, platformFees: 5,
            paymentProcessingFees: 1.5, shippingCost: 4, gradingCost: 2, otherCosts: 1)
        XCTAssertEqual(SalePnL.net(s, costBasis: 10), 34.5, accuracy: 0.0001)
    }
}
