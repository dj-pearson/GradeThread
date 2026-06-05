import XCTest
@testable import GradeThread

/// Pure daily-bucketing math for the dashboard trend sparkline. Like
/// DashboardRollupTests, runs without a ModelContainer. Uses a UTC calendar
/// so `startOfDay` bucketing is deterministic across machines.
final class DashboardTrendTests: XCTestCase {

    private var cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    /// 2023-11-14T22:13:20Z — fixed so windowing is reproducible.
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func test_seriesHasOnePointPerDay_endingToday() {
        let series = DashboardTrend.dailySeries(
            sales: [], items: [], days: 14, now: now, calendar: cal
        )
        XCTAssertEqual(series.count, 14)
        XCTAssertEqual(series.last?.date, cal.startOfDay(for: now))
        // Ascending by date.
        XCTAssertEqual(series.map(\.date), series.map(\.date).sorted())
    }

    func test_saleToday_landsInLastBucket() throws {
        let sale = makeSale(itemId: "a", price: 40, date: now)
        let series = DashboardTrend.dailySeries(
            sales: [sale], items: [], days: 14, now: now, calendar: cal
        )
        let last = try XCTUnwrap(series.last)
        XCTAssertEqual(last.revenue, 40, accuracy: 0.001)
        // No other bucket got revenue.
        XCTAssertEqual(series.dropLast().reduce(0) { $0 + $1.revenue }, 0, accuracy: 0.001)
    }

    func test_saleOutsideWindow_excluded() {
        let old = makeSale(itemId: "a", price: 999, date: now.addingTimeInterval(-20 * 86_400))
        let series = DashboardTrend.dailySeries(
            sales: [old], items: [], days: 14, now: now, calendar: cal
        )
        XCTAssertEqual(series.reduce(0) { $0 + $1.revenue }, 0, accuracy: 0.001)
        XCTAssertFalse(DashboardTrend.hasActivity(series))
    }

    func test_profitNetsFeesAndCostBasis() throws {
        let item = makeItem(id: "item-1", cost: 10)
        let sale = makeSale(itemId: "item-1", price: 50, fees: 5, date: now)
        let series = DashboardTrend.dailySeries(
            sales: [sale], items: [item], days: 14, now: now, calendar: cal
        )
        // 50 − 5 fees − 10 cost = 35 in today's bucket.
        let last = try XCTUnwrap(series.last)
        XCTAssertEqual(last.profit, 35, accuracy: 0.001)
        XCTAssertEqual(last.revenue, 50, accuracy: 0.001)
        XCTAssertTrue(DashboardTrend.hasActivity(series))
    }

    func test_multipleSalesSameDay_aggregate() throws {
        let s1 = makeSale(itemId: "a", price: 20, date: now)
        let s2 = makeSale(itemId: "b", price: 30, date: now.addingTimeInterval(-3600))
        let series = DashboardTrend.dailySeries(
            sales: [s1, s2], items: [], days: 14, now: now, calendar: cal
        )
        let last = try XCTUnwrap(series.last)
        XCTAssertEqual(last.revenue, 50, accuracy: 0.001)
    }

    func test_emptyWindow_hasNoActivity() {
        let series = DashboardTrend.dailySeries(
            sales: [], items: [], days: 14, now: now, calendar: cal
        )
        XCTAssertFalse(DashboardTrend.hasActivity(series))
    }

    // MARK: - Helpers

    private func makeItem(id: String, cost: Double?) -> LocalInventoryItem {
        let item = LocalInventoryItem(id: id, userId: "u", title: "Item", status: "sold")
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
}
