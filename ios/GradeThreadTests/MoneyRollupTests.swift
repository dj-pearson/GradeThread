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

    func test_grossProfit_subtractsFeesAndCostBasis() {
        let item = makeItem(id: "i1", cost: 30)
        let sale = makeSale(itemId: "i1", price: 100, fees: 12, date: now)
        let m = MoneyRollup.compute(items: [item], sales: [sale], now: now, calendar: cal)
        XCTAssertEqual(m.grossProfitThisMonth, 58, accuracy: 0.001) // 100 − 12 − 30
        XCTAssertEqual(m.roiThisMonth ?? -1, 58.0 / 30.0, accuracy: 0.001)
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

    func test_monthlyRevenue_bucketsSalesByMonth() {
        let nov = makeSale(price: 100, date: now)
        let oct = makeSale(price: 40, date: now.addingTimeInterval(-40 * 86_400))
        let m = MoneyRollup.compute(items: [], sales: [nov, oct], now: now, calendar: cal)
        XCTAssertEqual(m.monthlyRevenue.last?.revenue, 100, accuracy: 0.001)
        XCTAssertEqual(m.monthlyRevenue.first(where: { $0.label == "Oct" })?.revenue, 40, accuracy: 0.001)
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
