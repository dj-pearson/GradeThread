import XCTest
@testable import GradeThread

/// Pure analytics rollups over the local mirror (no ModelContainer needed).
final class AnalyticsRollupTests: XCTestCase {

    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    private func item(
        _ id: String,
        status: String = "cataloged",
        brand: String? = nil,
        cost: Double? = nil,
        grade: Double? = nil,
        tier: String? = nil
    ) -> LocalInventoryItem {
        let it = LocalInventoryItem(id: id, userId: "u", title: "Item", status: status)
        it.brand = brand
        it.acquiredPrice = cost
        it.gradeValue = grade
        it.gradeLabel = tier
        return it
    }

    private func sale(_ id: String, item: String, price: Double, fees: Double = 0, daysAgo: Int = 0) -> LocalSale {
        let date = Calendar.current.date(byAdding: .day, value: -daysAgo, to: epoch)!
        return LocalSale(id: id, inventoryItemId: item, salePrice: price, saleDate: date, platformFees: fees)
    }

    // MARK: Period P&L + grading ROI (US-665)

    func test_periodPnL_sumsRevenueFeesCogs() {
        let items = [item("a", cost: 10), item("b", cost: 20)]
        let sales = [sale("s1", item: "a", price: 100, fees: 12), sale("s2", item: "b", price: 50, fees: 5)]
        let pnl = AnalyticsRollup.periodPnL(items: items, sales: sales, since: nil)
        XCTAssertEqual(pnl.grossRevenue, 150)
        XCTAssertEqual(pnl.fees, 17)
        XCTAssertEqual(pnl.cogs, 30)
        XCTAssertEqual(pnl.grossProfit, 103)
        XCTAssertEqual(pnl.unitsSold, 2)
    }

    func test_gradingRoiBuckets_separatesGradedVsUngradedByBand() {
        let items = [
            item("g", cost: 10, grade: 9.0),   // graded
            item("u", cost: 10),               // ungraded
        ]
        // Same Under-$50 band; graded nets more.
        let sales = [
            sale("s1", item: "g", price: 40, fees: 0),  // net 30 graded
            sale("s2", item: "u", price: 30, fees: 0),  // net 20 ungraded
        ]
        let buckets = AnalyticsRollup.gradingRoiBuckets(items: items, sales: sales, since: nil)
        let band = buckets.first { $0.band == "Under $50" }
        XCTAssertNotNil(band)
        XCTAssertEqual(band?.gradedAvgNet, 30)
        XCTAssertEqual(band?.ungradedAvgNet, 20)
        XCTAssertEqual(band?.netProfitLift, 10)
    }

    // MARK: Range

    func test_range_start() {
        XCTAssertNil(AnalyticsRange.all.start(now: epoch))
        let d30 = AnalyticsRange.days30.start(now: epoch)
        XCTAssertEqual(d30, Calendar.current.date(byAdding: .day, value: -30, to: epoch))
    }

    // MARK: Grading

    func test_gradeDistribution_excludesUngraded_ordersHighToLow() {
        let items = [
            item("a", grade: 8.0, tier: "Excellent"),
            item("b", grade: 8.0, tier: "Excellent"),
            item("c", grade: 6.0, tier: "Good"),
            item("d"), // ungraded
        ]
        let dist = AnalyticsRollup.gradeDistribution(items: items)
        XCTAssertEqual(dist.map(\.tier), ["Excellent", "Good"])
        XCTAssertEqual(dist.first?.count, 2)
    }

    func test_gradedCount_and_average() {
        let items = [item("a", grade: 8.0), item("b", grade: 6.0), item("c")]
        XCTAssertEqual(AnalyticsRollup.gradedCount(items: items), 2)
        XCTAssertEqual(AnalyticsRollup.averageGrade(items: items), 7.0)
        XCTAssertNil(AnalyticsRollup.averageGrade(items: [item("z")]))
    }

    // MARK: Profit by brand

    func test_topBrandsByProfit_nets_groups_sorts() {
        let items = [
            item("a", brand: "Nike", cost: 10),
            item("b", brand: "Nike", cost: 20),
            item("c", brand: "Adidas", cost: 5),
        ]
        let sales = [
            sale("s1", item: "a", price: 50, fees: 5),   // net 35
            sale("s2", item: "b", price: 30, fees: 0),   // net 10  → Nike 45 / 2
            sale("s3", item: "c", price: 25, fees: 0),   // net 20  → Adidas 20 / 1
        ]
        let top = AnalyticsRollup.topBrandsByProfit(items: items, sales: sales, since: nil)
        XCTAssertEqual(top.map(\.brand), ["Nike", "Adidas"])
        XCTAssertEqual(top.first?.netProfit, 45)
        XCTAssertEqual(top.first?.unitsSold, 2)
    }

    func test_topBrandsByProfit_appliesSinceFilter_and_orphanSale() {
        let items = [item("a", brand: "Nike", cost: 10)]
        let sales = [
            sale("recent", item: "a", price: 50, fees: 0, daysAgo: 5),    // net 40
            sale("old", item: "a", price: 100, fees: 0, daysAgo: 100),    // excluded
            sale("orphan", item: "ghost", price: 30, fees: 0, daysAgo: 1) // Unknown, cost 0 → 30
        ]
        let since = AnalyticsRange.days30.start(now: epoch)
        let top = AnalyticsRollup.topBrandsByProfit(items: items, sales: sales, since: since)
        let nike = top.first { $0.brand == "Nike" }
        let unknown = top.first { $0.brand == "Unknown" }
        XCTAssertEqual(nike?.netProfit, 40)
        XCTAssertEqual(unknown?.netProfit, 30)
    }

    // MARK: Sell-through

    func test_sellThroughByBrand_onlyMarketItems() {
        let items = [
            item("a", status: "listed", brand: "Nike"),
            item("b", status: "sold", brand: "Nike"),
            item("c", status: "completed", brand: "Nike"),
            item("d", status: "cataloged", brand: "Nike"), // not on market → ignored
            item("e", status: "listed", brand: "Adidas"),
        ]
        let rows = AnalyticsRollup.sellThroughByBrand(items: items)
        let nike = rows.first { $0.brand == "Nike" }
        XCTAssertEqual(nike?.listed, 3)
        XCTAssertEqual(nike?.sold, 2)
        XCTAssertEqual(nike?.rate ?? 0, 2.0 / 3.0, accuracy: 0.001)
    }

    // MARK: Inventory value

    func test_inventoryValueByStatus_excludesSold() {
        let items = [
            item("a", status: "cataloged", cost: 10),
            item("b", status: "cataloged", cost: 5),
            item("c", status: "listed", cost: 20),
            item("d", status: "sold", cost: 99), // realized → excluded
        ]
        let rows = AnalyticsRollup.inventoryValueByStatus(items: items)
        let cataloged = rows.first { $0.status == "cataloged" }
        XCTAssertEqual(cataloged?.value, 15)
        XCTAssertEqual(cataloged?.count, 2)
        XCTAssertFalse(rows.contains { $0.status == "sold" })
        // Sorted by value desc → listed(20) before cataloged(15).
        XCTAssertEqual(rows.first?.status, "listed")
    }
}
