import GradeThreadCore
import XCTest
@testable import GradeThread

final class MoneyRollupTests: XCTestCase {

    /// UTC so month boundaries are deterministic regardless of runner tz.
    private let cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    /// 2023-11-14T22:13:20Z — mid-November, a stable fixture.
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func test_revenueThisMonth_countsOnlyCurrentMonth() {
        let thisMonth = makeSale(price: 100, date: now)
        let lastMonth = makeSale(price: 999, date: now.addingTimeInterval(-40 * 86_400))
        let m = MoneyRollup.compute(items: [], sales: [thisMonth, lastMonth], now: now, calendar: cal)
        XCTAssertEqual(m.revenueThisMonth, 100, accuracy: 0.001)
    }

    // US-1245: `netProfitThisMonth` (formerly mislabeled `grossProfit`) is the
    // FULL SalePnL net — revenue (incl. shipping collected) − all fees − seller
    // costs − cost basis — matching Dashboard/Analytics, NOT `price − fees − cogs`.
    func test_netProfit_usesFullSalePnLDefinition() {
        let item = makeItem(id: "i1", cost: 30)
        let sale = makeSale(itemId: "i1", price: 100, fees: 12, date: now)
        sale.shippingCollected = 10
        sale.paymentProcessingFees = 3
        sale.shippingCost = 5
        sale.gradingCost = 2
        sale.otherCosts = 1
        let m = MoneyRollup.compute(items: [item], sales: [sale], now: now, calendar: cal)
        // revenue 110 − fees 15 − sellerCosts 8 − cost basis 30 = 57
        XCTAssertEqual(m.netProfitThisMonth, 57, accuracy: 0.001)
        // The rollup must agree with the canonical helper to the cent.
        XCTAssertEqual(m.netProfitThisMonth, SalePnL.net(sale, costBasis: 30), accuracy: 0.001)
        // ROI is net / cost basis (return on cost), not gross-margin.
        XCTAssertEqual(m.roiThisMonth ?? -1, 57.0 / 30.0, accuracy: 0.001)
    }

    func test_roi_isNilWhenNoCostBasis() {
        let sale = makeSale(price: 50, fees: 5, date: now)
        let m = MoneyRollup.compute(items: [], sales: [sale], now: now, calendar: cal)
        XCTAssertNil(m.roiThisMonth)
    }

    func test_monthlyRevenue_sixBuckets_currentMonthLast() {
        let m = MoneyRollup.compute(items: [], sales: [], now: now, calendar: cal)
        XCTAssertEqual(m.monthlyRevenue.count, 6)
        XCTAssertEqual(m.monthlyRevenue.last?.label, "Nov")
        XCTAssertEqual(m.monthlyRevenue.first?.label, "Jun")
        XCTAssertEqual(m.monthlyRevenue.last?.revenue, 0)
    }

    func test_monthlyRevenue_bucketsSalesByMonth() throws {
        let nov = makeSale(price: 100, date: now)
        let oct = makeSale(price: 40, date: now.addingTimeInterval(-40 * 86_400))
        let m = MoneyRollup.compute(items: [], sales: [nov, oct], now: now, calendar: cal)
        let novBucket = try XCTUnwrap(m.monthlyRevenue.last)
        XCTAssertEqual(novBucket.revenue, 100, accuracy: 0.001)
        let octBucket = try XCTUnwrap(m.monthlyRevenue.first(where: { $0.label == "Oct" }))
        XCTAssertEqual(octBucket.revenue, 40, accuracy: 0.001)
    }

    // MARK: - FinancialExport (US-664)

    func test_financialExport_summaryAndRangeFilter() {
        let item = makeItem(id: "a", cost: 10)
        let inRange = makeSale(itemId: "a", price: 100, fees: 15, date: Date(timeIntervalSince1970: 1_700_000_000))
        let outOfRange = makeSale(itemId: "a", price: 999, fees: 0, date: Date(timeIntervalSince1970: 1_500_000_000))
        let start = Date(timeIntervalSince1970: 1_699_000_000)
        let end = Date(timeIntervalSince1970: 1_701_000_000)

        let txns = FinancialExport.transactions(sales: [inRange, outOfRange], items: [item], start: start, end: end)
        XCTAssertEqual(txns.count, 1, "out-of-range sale excluded")
        XCTAssertEqual(txns.first?.net, 100 - 15 - 10)

        let summary = FinancialExport.summary(txns)
        XCTAssertEqual(summary.grossRevenue, 100)
        XCTAssertEqual(summary.platformFees, 15)
        XCTAssertEqual(summary.cogs, 10)
        XCTAssertEqual(summary.netProfit, 75)
    }

    // US-1194: net must fold in shipping collected, processing fees, and seller
    // costs — matching SalePnL, not the old `salePrice - platformFees - cogs`.
    func test_financialExport_netUsesFullSalePnLFormula() throws {
        let item = makeItem(id: "a", cost: 10)
        let sale = makeSale(itemId: "a", price: 100, fees: 15, date: Date(timeIntervalSince1970: 1_700_000_000))
        sale.shippingCollected = 8
        sale.paymentProcessingFees = 3
        sale.shippingCost = 6
        sale.gradingCost = 2
        sale.otherCosts = 1
        let start = Date(timeIntervalSince1970: 1_699_000_000)
        let end = Date(timeIntervalSince1970: 1_701_000_000)

        let txns = FinancialExport.transactions(sales: [sale], items: [item], start: start, end: end)
        let txn = try XCTUnwrap(txns.first)
        // revenue 108 − fees 18 − sellerCosts 9 − cogs 10 = 71
        XCTAssertEqual(txn.net, 71, accuracy: 0.001)

        let summary = FinancialExport.summary(txns)
        XCTAssertEqual(summary.grossRevenue, 108, accuracy: 0.001)
        XCTAssertEqual(summary.platformFees, 18, accuracy: 0.001)
        XCTAssertEqual(summary.sellerCosts, 9, accuracy: 0.001)
        XCTAssertEqual(summary.cogs, 10, accuracy: 0.001)
        XCTAssertEqual(summary.netProfit, 71, accuracy: 0.001)
    }

    func test_financialExport_csvHasSummaryAndTransactionSections() {
        let item = makeItem(id: "a", cost: 5)
        let sale = makeSale(itemId: "a", price: 50, fees: 5, date: Date(timeIntervalSince1970: 1_700_000_000))
        let csv = FinancialExport.csv(
            sales: [sale], items: [item],
            start: Date(timeIntervalSince1970: 1_699_000_000),
            end: Date(timeIntervalSince1970: 1_701_000_000)
        )
        XCTAssertTrue(csv.contains("SUMMARY"))
        XCTAssertTrue(csv.contains("Net Profit,40.00"))
        XCTAssertTrue(csv.contains("TRANSACTION DETAILS"))
    }

    // MARK: - Helpers

    private func makeItem(id: String, cost: Double) -> LocalInventoryItem {
        let item = LocalInventoryItem(id: id, userId: "u", title: "Item", status: "sold")
        item.acquiredPrice = cost
        return item
    }

    private func makeSale(
        itemId: String = "x", price: Double, fees: Double = 0, date: Date
    ) -> LocalSale {
        LocalSale(
            id: UUID().uuidString,
            inventoryItemId: itemId,
            salePrice: price,
            saleDate: date,
            platformFees: fees
        )
    }
}
