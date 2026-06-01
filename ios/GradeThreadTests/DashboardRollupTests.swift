import XCTest
@testable import GradeThread

/// Exercises the pure Home-tab rollup math (no ModelContainer needed —
/// SwiftData `@Model` types are constructible directly, same as
/// WidgetSnapshotTests).
final class DashboardRollupTests: XCTestCase {

    private let cal = Calendar(identifier: .gregorian)
    /// Fixed instant so windowing is deterministic.
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - Inventory value / counts

    func test_inventoryValue_sumsCostOfOnHandItemsOnly() {
        let items = [
            makeItem(status: "cataloged", cost: 10),
            makeItem(status: "listed", cost: 20),
            makeItem(status: "sold", cost: 99),        // realized — excluded
            makeItem(status: "archived", cost: 50),    // parked — excluded
        ]
        let m = DashboardRollup.compute(
            items: items, sales: [], now: now, calendar: cal
        )
        XCTAssertEqual(m.inventoryValue, 30, accuracy: 0.001)
        XCTAssertEqual(m.onHandCount, 2)
    }

    func test_listedCount_countsOnlyListedStatus() {
        let items = [
            makeItem(status: "listed", cost: 5),
            makeItem(status: "listed", cost: 5),
            makeItem(status: "drafted", cost: 5),
            makeItem(status: "cataloged", cost: 5),
        ]
        let m = DashboardRollup.compute(
            items: items, sales: [], now: now, calendar: cal
        )
        XCTAssertEqual(m.listedCount, 2)
    }

    func test_missingCost_treatedAsZero() {
        let items = [makeItem(status: "cataloged", cost: nil)]
        let m = DashboardRollup.compute(
            items: items, sales: [], now: now, calendar: cal
        )
        XCTAssertEqual(m.inventoryValue, 0, accuracy: 0.001)
        XCTAssertEqual(m.onHandCount, 1)
    }

    // MARK: - This-week money

    func test_weekWindow_excludesSalesOlderThanSevenDays() {
        let recent = makeSale(itemId: "a", price: 50, date: now.addingTimeInterval(-3 * 86_400))
        let old = makeSale(itemId: "b", price: 999, date: now.addingTimeInterval(-10 * 86_400))
        let m = DashboardRollup.compute(
            items: [], sales: [recent, old], now: now, calendar: cal
        )
        XCTAssertEqual(m.soldThisWeekCount, 1)
        XCTAssertEqual(m.revenueThisWeek, 50, accuracy: 0.001)
    }

    func test_netProfit_subtractsFeesAndCostBasis() {
        let item = makeItem(id: "item-1", status: "sold", cost: 10)
        let sale = makeSale(itemId: "item-1", price: 50, fees: 5, date: now.addingTimeInterval(-86_400))
        let m = DashboardRollup.compute(
            items: [item], sales: [sale], now: now, calendar: cal
        )
        // 50 revenue − 5 fees − 10 cost = 35
        XCTAssertEqual(m.netProfitThisWeek, 35, accuracy: 0.001)
    }

    func test_netProfit_orphanSale_usesZeroCost_noCrash() {
        // Sale references an item not in the local cache (e.g. pulled before
        // its item row landed) — cost basis falls back to zero.
        let sale = makeSale(itemId: "ghost", price: 40, fees: 4, date: now.addingTimeInterval(-86_400))
        let m = DashboardRollup.compute(
            items: [], sales: [sale], now: now, calendar: cal
        )
        XCTAssertEqual(m.netProfitThisWeek, 36, accuracy: 0.001)
        XCTAssertEqual(m.soldThisWeekCount, 1)
    }

    // MARK: - Aging

    func test_isAging_onHandItemPastThreshold_isAging() {
        let item = makeItem(status: "cataloged", cost: 5, updatedAt: now.addingTimeInterval(-20 * 86_400))
        XCTAssertTrue(DashboardRollup.isAging(item, now: now, calendar: cal))
    }

    func test_isAging_recentOnHandItem_isNotAging() {
        let item = makeItem(status: "cataloged", cost: 5, updatedAt: now.addingTimeInterval(-2 * 86_400))
        XCTAssertFalse(DashboardRollup.isAging(item, now: now, calendar: cal))
    }

    func test_isAging_soldItem_neverAging_evenWhenOld() {
        let item = makeItem(status: "sold", cost: 5, updatedAt: now.addingTimeInterval(-60 * 86_400))
        XCTAssertFalse(DashboardRollup.isAging(item, now: now, calendar: cal))
    }

    func test_agingCount_countsOnlyStaleOnHandItems() {
        let items = [
            makeItem(status: "cataloged", cost: 5, updatedAt: now.addingTimeInterval(-20 * 86_400)), // aging
            makeItem(status: "listed", cost: 5, updatedAt: now.addingTimeInterval(-30 * 86_400)),    // aging
            makeItem(status: "cataloged", cost: 5, updatedAt: now),                                  // fresh
            makeItem(status: "sold", cost: 5, updatedAt: now.addingTimeInterval(-90 * 86_400)),      // sold
        ]
        let m = DashboardRollup.compute(
            items: items, sales: [], now: now, calendar: cal
        )
        XCTAssertEqual(m.agingCount, 2)
    }

    // MARK: - Empty

    func test_emptyData_isAllZeros() {
        let m = DashboardRollup.compute(
            items: [], sales: [], now: now, calendar: cal
        )
        XCTAssertEqual(m, .empty)
    }

    // MARK: - Helpers

    private func makeItem(
        id: String = UUID().uuidString,
        status: String,
        cost: Double?,
        updatedAt: Date = Date(timeIntervalSince1970: 1_700_000_000)
    ) -> LocalInventoryItem {
        let item = LocalInventoryItem(
            id: id, userId: "u", title: "Item", status: status, updatedAt: updatedAt
        )
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
