import XCTest
@testable import GradeThread

/// US-812 — pure-rollup tests for the Money-tab financial analytics.
final class MoneyAnalyticsRollupTests: XCTestCase {

    /// UTC so month/day boundaries are deterministic regardless of runner tz.
    private let cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    /// 2023-11-14T22:13:20Z — mid-November, a stable fixture.
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func daysAgo(_ days: Int) -> Date { now.addingTimeInterval(Double(-days) * 86_400) }

    // MARK: - Inventory aging

    func test_inventoryAging_alwaysReturnsFourOrderedBrackets() {
        let brackets = MoneyAnalyticsRollup.inventoryAging(items: [], now: now, calendar: cal)
        XCTAssertEqual(brackets.map(\.label), ["0-14 days", "15-30 days", "31-60 days", "60+ days"])
        XCTAssertTrue(brackets.allSatisfy { $0.count == 0 && $0.value == 0 })
    }

    func test_inventoryAging_bucketsOnHandItemsByAgeAndSumsCostBasis() {
        let fresh = makeItem(id: "a", cost: 10, status: "cataloged", created: daysAgo(3))
        let mid = makeItem(id: "b", cost: 20, status: "listed", created: daysAgo(20))
        let old = makeItem(id: "c", cost: 30, status: "listed", created: daysAgo(90))
        let alsoOld = makeItem(id: "d", cost: 5, status: "photographed", created: daysAgo(70))
        // A SOLD item is realized, not on-hand → excluded.
        let sold = makeItem(id: "e", cost: 99, status: "sold", created: daysAgo(2))

        let brackets = MoneyAnalyticsRollup.inventoryAging(
            items: [fresh, mid, old, alsoOld, sold], now: now, calendar: cal
        )
        let byLabel = Dictionary(uniqueKeysWithValues: brackets.map { ($0.label, $0) })
        XCTAssertEqual(byLabel["0-14 days"]?.count, 1)
        XCTAssertEqual(byLabel["0-14 days"]?.value ?? -1, 10, accuracy: 0.001)
        XCTAssertEqual(byLabel["15-30 days"]?.count, 1)
        XCTAssertEqual(byLabel["31-60 days"]?.count, 0)
        XCTAssertEqual(byLabel["60+ days"]?.count, 2)
        XCTAssertEqual(byLabel["60+ days"]?.value ?? -1, 35, accuracy: 0.001)
    }

    func test_inventoryAging_boundaryDayLandsInLowerBracket() {
        let exactly14 = makeItem(id: "a", cost: 1, status: "listed", created: daysAgo(14))
        let exactly15 = makeItem(id: "b", cost: 1, status: "listed", created: daysAgo(15))
        let brackets = MoneyAnalyticsRollup.inventoryAging(
            items: [exactly14, exactly15], now: now, calendar: cal
        )
        let byLabel = Dictionary(uniqueKeysWithValues: brackets.map { ($0.label, $0) })
        XCTAssertEqual(byLabel["0-14 days"]?.count, 1)
        XCTAssertEqual(byLabel["15-30 days"]?.count, 1)
    }

    func test_inventoryAging_anchorsOnAcquiredDateWhenPresent() {
        // US-1246: a backfilled row created recently but acquired long ago should
        // bucket by the real acquisition date, not the mirror's createdAt.
        let backfilled = makeItem(id: "a", cost: 12, status: "listed", created: daysAgo(2))
        backfilled.acquiredDate = daysAgo(90)
        let brackets = MoneyAnalyticsRollup.inventoryAging(
            items: [backfilled], now: now, calendar: cal
        )
        let byLabel = Dictionary(uniqueKeysWithValues: brackets.map { ($0.label, $0) })
        XCTAssertEqual(byLabel["60+ days"]?.count, 1)     // by acquiredDate
        XCTAssertEqual(byLabel["0-14 days"]?.count, 0)    // not by createdAt
    }

    // MARK: - Time on market

    func test_timeOnMarket_emptyWhenNoSales() {
        let stats = MoneyAnalyticsRollup.timeOnMarket(items: [], sales: [], now: now, calendar: cal)
        XCTAssertFalse(stats.hasData)
        XCTAssertNil(stats.averageDays)
    }

    func test_timeOnMarket_averagesDaysFromAcquisitionToSale() {
        let i1 = makeItem(id: "a", cost: 0, status: "sold", created: daysAgo(40))
        let i2 = makeItem(id: "b", cost: 0, status: "sold", created: daysAgo(40))
        // Sold today: held 10d and 30d respectively → avg 20.
        let s1 = makeSale(itemId: "a", price: 50, date: i1.createdAt.addingTimeInterval(10 * 86_400))
        let s2 = makeSale(itemId: "b", price: 50, date: i2.createdAt.addingTimeInterval(30 * 86_400))
        let stats = MoneyAnalyticsRollup.timeOnMarket(
            items: [i1, i2], sales: [s1, s2], now: now, calendar: cal
        )
        XCTAssertEqual(stats.soldCount, 2)
        XCTAssertEqual(stats.averageDays ?? -1, 20, accuracy: 0.001)
        let dist = Dictionary(uniqueKeysWithValues: stats.distribution.map { ($0.label, $0.count) })
        XCTAssertEqual(dist["8-30 days"], 2)
        XCTAssertEqual(dist["≤7 days"], 0)
    }

    func test_timeOnMarket_skipsSalesWithoutAKnownItem() {
        let orphan = makeSale(itemId: "ghost", price: 50, date: now)
        let stats = MoneyAnalyticsRollup.timeOnMarket(
            items: [], sales: [orphan], now: now, calendar: cal
        )
        XCTAssertFalse(stats.hasData)
    }

    func test_timeOnMarket_excludesCancelledSales() {
        let item = makeItem(id: "a", cost: 0, status: "sold", created: daysAgo(20))
        let cancelled = makeSale(itemId: "a", price: 50, date: now)
        cancelled.status = "cancelled"
        let stats = MoneyAnalyticsRollup.timeOnMarket(
            items: [item], sales: [cancelled], now: now, calendar: cal
        )
        XCTAssertFalse(stats.hasData)
    }

    // MARK: - Cash flow

    func test_cashFlow_sixMonthsOldestToNewest() {
        let flow = MoneyAnalyticsRollup.cashFlow(
            items: [], sales: [], expenses: [], now: now, calendar: cal
        )
        XCTAssertEqual(flow.count, 6)
        XCTAssertEqual(flow.first?.label, "Jun")
        XCTAssertEqual(flow.last?.label, "Nov")
    }

    func test_cashFlow_splitsRevenueExpensesAndCostBasisByMonth() {
        let item = makeItem(id: "a", cost: 30, status: "sold", created: daysAgo(5))
        let sale = makeSale(itemId: "a", price: 100, fees: 12, date: now) // Nov
        let novExpense = makeExpense(amount: 8, on: now)
        let octExpense = makeExpense(amount: 5, on: daysAgo(40))

        let flow = MoneyAnalyticsRollup.cashFlow(
            items: [item], sales: [sale], expenses: [novExpense, octExpense],
            now: now, calendar: cal
        )
        let nov = flow.first { $0.label == "Nov" }
        XCTAssertEqual(nov?.revenue ?? -1, 100, accuracy: 0.001)
        XCTAssertEqual(nov?.costBasis ?? -1, 30, accuracy: 0.001)
        XCTAssertEqual(nov?.expenses ?? -1, 8, accuracy: 0.001)
        // net = 100 − 8 − 30 = 62 (fees are not part of cash-flow cost basis here).
        XCTAssertEqual(nov?.net ?? -1, 62, accuracy: 0.001)

        let oct = flow.first { $0.label == "Oct" }
        XCTAssertEqual(oct?.expenses ?? -1, 5, accuracy: 0.001)
        XCTAssertEqual(oct?.revenue ?? -1, 0, accuracy: 0.001)
    }

    // MARK: - Per-item P&L

    func test_itemProfitRows_computesNetAndRoiPerSale() {
        let item = makeItem(id: "a", cost: 25, status: "sold", created: daysAgo(10))
        let sale = makeSale(itemId: "a", price: 100, fees: 15, date: now)
        let rows = MoneyAnalyticsRollup.itemProfitRows(items: [item], sales: [sale])
        XCTAssertEqual(rows.count, 1)
        let row = rows[0]
        XCTAssertEqual(row.revenue, 100, accuracy: 0.001)
        XCTAssertEqual(row.fees, 15, accuracy: 0.001)
        XCTAssertEqual(row.costBasis, 25, accuracy: 0.001)
        XCTAssertEqual(row.netProfit, 60, accuracy: 0.001) // 100 − 15 − 25
        XCTAssertEqual(row.roi ?? -1, 60.0 / 25.0, accuracy: 0.001)
    }

    func test_itemProfitRows_nilRoiWhenNoCostBasis() {
        let sale = makeSale(itemId: "ghost", price: 50, fees: 5, date: now)
        let rows = MoneyAnalyticsRollup.itemProfitRows(items: [], sales: [sale])
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows[0].roi)
        XCTAssertEqual(rows[0].title, "Untitled item")
    }

    func test_itemProfitRows_excludesCancelledSales() {
        let item = makeItem(id: "a", cost: 10, status: "sold", created: daysAgo(10))
        let ok = makeSale(itemId: "a", price: 50, date: now)
        let cancelled = makeSale(itemId: "a", price: 999, date: now)
        cancelled.status = "refunded"
        let rows = MoneyAnalyticsRollup.itemProfitRows(items: [item], sales: [ok, cancelled])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].revenue, 50, accuracy: 0.001)
    }

    func test_sortProfitRows_byProfitAndRoiAndRecent() {
        let big = makeItem(id: "big", cost: 100, status: "sold", created: daysAgo(30))
        let small = makeItem(id: "small", cost: 5, status: "sold", created: daysAgo(30))
        // big: net 150 − 100 = 50, ROI 0.5; small: net 20 − 5 = 15, ROI 3.0
        let bigSale = makeSale(itemId: "big", price: 150, date: daysAgo(1))
        let smallSale = makeSale(itemId: "small", price: 20, date: daysAgo(2))
        let rows = MoneyAnalyticsRollup.itemProfitRows(items: [big, small], sales: [bigSale, smallSale])

        let byProfit = MoneyAnalyticsRollup.sortProfitRows(rows, by: .profit)
        XCTAssertEqual(byProfit.first?.itemId, "big")
        let byRoi = MoneyAnalyticsRollup.sortProfitRows(rows, by: .roi)
        XCTAssertEqual(byRoi.first?.itemId, "small")
        let byRecent = MoneyAnalyticsRollup.sortProfitRows(rows, by: .recent)
        XCTAssertEqual(byRecent.first?.itemId, "big") // sold 1 day ago
    }

    func test_sortProfitRows_roiSortsNoCostBasisLast() {
        let graded = makeItem(id: "a", cost: 10, status: "sold", created: daysAgo(20))
        let s1 = makeSale(itemId: "a", price: 30, date: now)        // ROI present
        let s2 = makeSale(itemId: "ghost", price: 30, date: now)    // ROI nil
        let rows = MoneyAnalyticsRollup.itemProfitRows(items: [graded], sales: [s1, s2])
        let byRoi = MoneyAnalyticsRollup.sortProfitRows(rows, by: .roi)
        XCTAssertEqual(byRoi.first?.itemId, "a")
        XCTAssertNil(byRoi.last?.roi)
    }

    // MARK: - Helpers

    private func makeItem(
        id: String, cost: Double, status: String, created: Date
    ) -> LocalInventoryItem {
        let item = LocalInventoryItem(id: id, userId: "u", title: "Item \(id)", status: status, createdAt: created)
        item.acquiredPrice = cost
        return item
    }

    private func makeSale(
        itemId: String, price: Double, fees: Double = 0, date: Date
    ) -> LocalSale {
        LocalSale(
            id: UUID().uuidString,
            inventoryItemId: itemId,
            salePrice: price,
            saleDate: date,
            platformFees: fees
        )
    }

    private func makeExpense(amount: Double, on date: Date) -> LocalExpense {
        LocalExpense(id: UUID().uuidString, category: "supplies", amount: amount, spentOn: date)
    }
}
