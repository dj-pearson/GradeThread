import Foundation
import XCTest
@testable import GradeThreadCore

/// Pure daily-bucketing math for the dashboard trend sparkline — runs on Linux
/// over plain value types (no SwiftData, no ModelContainer, no Mac). Uses a UTC
/// calendar so `startOfDay` bucketing is deterministic across machines.
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
            sales: [SaleStub](), items: [ItemStub](), days: 14, now: now, calendar: cal
        )
        XCTAssertEqual(series.count, 14)
        XCTAssertEqual(series.last?.date, cal.startOfDay(for: now))
        // Ascending by date.
        XCTAssertEqual(series.map(\.date), series.map(\.date).sorted())
    }

    func test_saleToday_landsInLastBucket() throws {
        let sale = SaleStub(inventoryItemId: "a", salePrice: 40, saleDate: now)
        let series = DashboardTrend.dailySeries(
            sales: [sale], items: [ItemStub](), days: 14, now: now, calendar: cal
        )
        let last = try XCTUnwrap(series.last)
        XCTAssertEqual(last.revenue, 40, accuracy: 0.001)
        // No other bucket got revenue.
        XCTAssertEqual(series.dropLast().reduce(0) { $0 + $1.revenue }, 0, accuracy: 0.001)
    }

    func test_saleOutsideWindow_excluded() {
        let old = SaleStub(
            inventoryItemId: "a", salePrice: 999, saleDate: now.addingTimeInterval(-20 * 86_400)
        )
        let series = DashboardTrend.dailySeries(
            sales: [old], items: [ItemStub](), days: 14, now: now, calendar: cal
        )
        XCTAssertEqual(series.reduce(0) { $0 + $1.revenue }, 0, accuracy: 0.001)
        XCTAssertFalse(DashboardTrend.hasActivity(series))
    }

    func test_profitNetsFeesAndCostBasis() throws {
        let item = ItemStub(id: "item-1", acquiredPrice: 10)
        let sale = SaleStub(
            inventoryItemId: "item-1", salePrice: 50, platformFees: 5, saleDate: now
        )
        let series = DashboardTrend.dailySeries(
            sales: [sale], items: [item], days: 14, now: now, calendar: cal
        )
        // 50 − 5 fees − 10 cost = 35 in today's bucket.
        let last = try XCTUnwrap(series.last)
        XCTAssertEqual(last.profit, 35, accuracy: 0.001)
        XCTAssertEqual(last.revenue, 50, accuracy: 0.001)
        XCTAssertTrue(DashboardTrend.hasActivity(series))
    }

    func test_refundedSale_excludedFromTrend() throws {
        let completed = SaleStub(inventoryItemId: "a", salePrice: 40, saleDate: now)
        let refunded = SaleStub(
            status: "refunded", inventoryItemId: "b", salePrice: 100, saleDate: now
        )
        let series = DashboardTrend.dailySeries(
            sales: [completed, refunded], items: [ItemStub](), days: 14, now: now, calendar: cal
        )
        let last = try XCTUnwrap(series.last)
        // Only the completed $40 sale counts — the $100 refund is excluded, so
        // the trend agrees with the DashboardMetrics KPI card.
        XCTAssertEqual(last.revenue, 40, accuracy: 0.001)
    }

    func test_multipleSalesSameDay_aggregate() throws {
        let s1 = SaleStub(inventoryItemId: "a", salePrice: 20, saleDate: now)
        let s2 = SaleStub(
            inventoryItemId: "b", salePrice: 30, saleDate: now.addingTimeInterval(-3600)
        )
        let series = DashboardTrend.dailySeries(
            sales: [s1, s2], items: [ItemStub](), days: 14, now: now, calendar: cal
        )
        let last = try XCTUnwrap(series.last)
        XCTAssertEqual(last.revenue, 50, accuracy: 0.001)
    }

    func test_zeroDays_returnsEmpty() {
        let series = DashboardTrend.dailySeries(
            sales: [SaleStub](), items: [ItemStub](), days: 0, now: now, calendar: cal
        )
        XCTAssertTrue(series.isEmpty)
    }

    func test_emptyWindow_hasNoActivity() {
        let series = DashboardTrend.dailySeries(
            sales: [SaleStub](), items: [ItemStub](), days: 14, now: now, calendar: cal
        )
        XCTAssertFalse(DashboardTrend.hasActivity(series))
    }

    // MARK: - Fakes

    private struct SaleStub: DatedSale {
        var status: String = ""
        var inventoryItemId: String
        var salePrice: Double
        var shippingCollected: Double?
        var platformFees: Double = 0
        var paymentProcessingFees: Double?
        var shippingCost: Double?
        var gradingCost: Double?
        var otherCosts: Double?
        var saleDate: Date
    }

    private struct ItemStub: ItemCost {
        var id: String
        var acquiredPrice: Double?
    }
}
