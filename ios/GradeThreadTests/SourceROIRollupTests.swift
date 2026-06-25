import XCTest
@testable import GradeThread

/// US-677 — per-source ROI + sourcing-budget arithmetic. Pure functions, so no
/// ModelContainer is needed (same approach as MoneyRollupTests).
final class SourceROIRollupTests: XCTestCase {

    private func item(_ id: String, source: String?, cost: Double, status: String = "cataloged", created: Date = .now) -> LocalInventoryItem {
        let it = LocalInventoryItem(id: id, userId: "u", title: "t", status: status, createdAt: created)
        it.sourceId = source
        it.acquiredPrice = cost
        return it
    }
    private func sale(_ itemId: String, price: Double, fees: Double) -> LocalSale {
        LocalSale(id: "s-\(itemId)", inventoryItemId: itemId, salePrice: price, saleDate: .now, platformFees: fees)
    }
    private func source(_ id: String, _ name: String) -> LocalSource {
        LocalSource(id: id, userId: "u", name: name)
    }

    func test_bySource_groupsProfitAndSellThrough() {
        let items = [
            item("a", source: "g", cost: 10, status: "sold"),
            item("b", source: "g", cost: 20),                       // unsold
            item("c", source: "e", cost: 5, status: "sold"),
        ]
        let sales = [sale("a", price: 50, fees: 5), sale("c", price: 15, fees: 2)]
        let rows = SourceROIRollup.bySource(
            items: items, sales: sales,
            sources: [source("g", "Goodwill"), source("e", "Estate")]
        )

        let goodwill = rows.first { $0.sourceId == "g" }!
        XCTAssertEqual(goodwill.sourceName, "Goodwill")
        XCTAssertEqual(goodwill.acquiredCount, 2)
        XCTAssertEqual(goodwill.soldCount, 1)
        XCTAssertEqual(goodwill.spend, 30, accuracy: 0.001)         // 10 + 20
        XCTAssertEqual(goodwill.netProfit, 35, accuracy: 0.001)     // 50 − 5 − 10
        XCTAssertEqual(goodwill.roi ?? -1, 35.0 / 30.0, accuracy: 0.001)
        XCTAssertEqual(goodwill.sellThrough, 0.5, accuracy: 0.001)
    }

    func test_bySource_unattributedBucket() {
        let items = [item("x", source: nil, cost: 8, status: "sold")]
        let sales = [sale("x", price: 20, fees: 0)]
        let rows = SourceROIRollup.bySource(items: items, sales: sales, sources: [])
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows[0].sourceId)
        XCTAssertEqual(rows[0].sourceName, SourceROIRollup.unattributedName)
        XCTAssertEqual(rows[0].netProfit, 12, accuracy: 0.001)
    }

    func test_bySource_sortedByNetProfitDescending() {
        let items = [
            item("a", source: "low", cost: 5, status: "sold"),
            item("b", source: "high", cost: 5, status: "sold"),
        ]
        let sales = [sale("a", price: 10, fees: 0), sale("b", price: 100, fees: 0)]
        let rows = SourceROIRollup.bySource(
            items: items, sales: sales,
            sources: [source("low", "Low"), source("high", "High")]
        )
        XCTAssertEqual(rows.first?.sourceId, "high")
    }

    func test_roi_isNilWithoutSpend() {
        // Sale attributed to an item we don't have locally -> No source, no spend.
        let rows = SourceROIRollup.bySource(
            items: [], sales: [sale("ghost", price: 30, fees: 3)], sources: [])
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows[0].roi)
        XCTAssertEqual(rows[0].revenue, 30, accuracy: 0.001)
    }

    func test_bySource_excludesCancelledAndRefundedSales() {
        // US-1269: a reversed sale must not inflate a source's revenue/profit.
        let items = [
            item("a", source: "g", cost: 10, status: "sold"),
            item("b", source: "g", cost: 10, status: "sold"),
        ]
        let good = sale("a", price: 50, fees: 5)
        let refunded = sale("b", price: 50, fees: 5)
        refunded.status = "refunded"
        let rows = SourceROIRollup.bySource(
            items: items, sales: [good, refunded], sources: [source("g", "Goodwill")]
        )
        let g = rows.first { $0.sourceId == "g" }!
        XCTAssertEqual(g.soldCount, 1)                       // only the completed sale
        XCTAssertEqual(g.revenue, 50, accuracy: 0.001)
        XCTAssertEqual(g.netProfit, 35, accuracy: 0.001)     // 50 − 5 − 10
    }

    func test_bySource_includesPaymentProcessingFees() {
        // US-1269: fees must be platform + payment-processing (SalePnL.fees).
        let items = [item("a", source: "g", cost: 10, status: "sold")]
        let s = sale("a", price: 50, fees: 5)
        s.paymentProcessingFees = 2
        let rows = SourceROIRollup.bySource(
            items: items, sales: [s], sources: [source("g", "Goodwill")]
        )
        let g = rows.first { $0.sourceId == "g" }!
        XCTAssertEqual(g.fees, 7, accuracy: 0.001)           // 5 + 2
        XCTAssertEqual(g.netProfit, 33, accuracy: 0.001)     // 50 − 7 − 10
    }

    func test_budgetStatus_windowsByCreationDate() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let old = now.addingTimeInterval(-40 * 86_400)
        let items = [
            item("a", source: nil, cost: 100, created: now),
            item("b", source: nil, cost: 999, created: old),     // outside window
        ]
        let status = SourceROIRollup.budgetStatus(
            items: items, budget: 250, since: now.addingTimeInterval(-30 * 86_400))
        XCTAssertEqual(status.spent, 100, accuracy: 0.001)
        XCTAssertEqual(status.remaining, 150, accuracy: 0.001)
        XCTAssertFalse(status.isOver)
        XCTAssertEqual(status.fraction, 0.4, accuracy: 0.001)
    }

    func test_budgetStatus_overBudgetClampsFraction() {
        let status = SourceROIRollup.budgetStatus(
            items: [item("a", source: nil, cost: 500)], budget: 100, since: nil)
        XCTAssertTrue(status.isOver)
        XCTAssertEqual(status.fraction, 1.0, accuracy: 0.001)
        XCTAssertEqual(status.remaining, -400, accuracy: 0.001)
    }
}
