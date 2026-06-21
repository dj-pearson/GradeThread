import XCTest
@testable import GradeThread

/// US-1128 — pure-helper + decode tests for the iOS Listing Performance surface
/// (parity with `src/pages/flipdesk/listing-performance.tsx`).
final class ListingPerformanceTests: XCTestCase {

    /// 2023-11-14T22:13:20Z — stable fixture so day math is deterministic.
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func iso(daysAgo days: Int) -> String {
        let f = ISO8601DateFormatter()
        return f.string(from: now.addingTimeInterval(Double(-days) * 86_400))
    }

    private func row(
        id: String,
        title: String? = nil,
        views: Int = 0,
        watchers: Int = 0,
        impressions: Int = 0,
        ctr: Double? = nil,
        listedDaysAgo: Int = 0
    ) -> ListingPerformanceRow {
        ListingPerformanceRow(
            id: id,
            inventoryItemId: "item-\(id)",
            listingTitle: title,
            listingPrice: 25,
            listedAt: iso(daysAgo: listedDaysAgo),
            viewsTotal: views,
            watchersCount: watchers,
            impressions7d: impressions,
            clickThroughRate: ctr
        )
    }

    // MARK: - daysListed / isStale

    func test_daysListed_countsWholeDaysAndFloorsAtZero() {
        XCTAssertEqual(ListingPerformance.daysListed(iso(daysAgo: 10), now: now), 10)
        XCTAssertEqual(ListingPerformance.daysListed(nil, now: now), 0)
        XCTAssertEqual(ListingPerformance.daysListed("", now: now), 0)
        // A future timestamp can't be negative.
        XCTAssertEqual(ListingPerformance.daysListed(iso(daysAgo: -5), now: now), 0)
    }

    func test_isStale_zeroViewsAfterTwoWeeks() {
        XCTAssertTrue(ListingPerformance.isStale(row(id: "a", views: 0, listedDaysAgo: 20), now: now))
        // Has views → not stale.
        XCTAssertFalse(ListingPerformance.isStale(row(id: "b", views: 3, listedDaysAgo: 20), now: now))
        // Zero views but fresh → not yet stale.
        XCTAssertFalse(ListingPerformance.isStale(row(id: "c", views: 0, listedDaysAgo: 5), now: now))
    }

    // MARK: - resolve (sort + filter)

    func test_resolve_sortsByViewsDescendingByDefault() {
        let rows = [
            row(id: "a", views: 5),
            row(id: "b", views: 50),
            row(id: "c", views: 1),
        ]
        let out = ListingPerformance.resolve(
            rows, sort: .views, ascending: false, titleFor: { $0.id }, now: now)
        XCTAssertEqual(out.map(\.id), ["b", "a", "c"])
    }

    func test_resolve_ctrNilSortsBelowRealValues() {
        let rows = [
            row(id: "a", ctr: nil),
            row(id: "b", ctr: 0.02),
            row(id: "c", ctr: 0.10),
        ]
        let out = ListingPerformance.resolve(
            rows, sort: .ctr, ascending: false, titleFor: { $0.id }, now: now)
        XCTAssertEqual(out.map(\.id), ["c", "b", "a"])
    }

    func test_resolve_titleSortIsCaseInsensitiveAscending() {
        let rows = [
            row(id: "a", title: "zebra"),
            row(id: "b", title: "Apple"),
        ]
        let out = ListingPerformance.resolve(
            rows, sort: .title, ascending: true, titleFor: { $0.listingTitle ?? "" }, now: now)
        XCTAssertEqual(out.map(\.id), ["b", "a"])
    }

    func test_resolve_noViewFilterKeepsOnlyAgedZeroViewListings() {
        let rows = [
            row(id: "stale", views: 0, listedDaysAgo: 30),
            row(id: "fresh", views: 0, listedDaysAgo: 3),
            row(id: "seen", views: 9, listedDaysAgo: 40),
        ]
        let out = ListingPerformance.resolve(
            rows, sort: .views, ascending: false, minNoViewDays: 14,
            titleFor: { $0.id }, now: now)
        XCTAssertEqual(out.map(\.id), ["stale"])
    }

    func test_resolve_noFilterReturnsEverything() {
        let rows = [row(id: "a", views: 0), row(id: "b", views: 1)]
        let out = ListingPerformance.resolve(
            rows, sort: .views, ascending: false, minNoViewDays: nil,
            titleFor: { $0.id }, now: now)
        XCTAssertEqual(out.count, 2)
    }

    // MARK: - Decoding (supabase PostgREST: no convertFromSnakeCase)

    func test_decode_mapsSnakeCaseColumnsAndTrend() throws {
        let json = """
        {
          "id": "l1",
          "inventory_item_id": "i1",
          "listing_title": "Vintage Jacket",
          "listing_url": "https://ebay.com/itm/1",
          "listing_price": 42.5,
          "listed_at": "2026-06-01T00:00:00Z",
          "views_total": 120,
          "watchers_count": 4,
          "impressions_7d": 800,
          "click_through_rate": 0.15,
          "last_metrics_synced_at": "2026-06-20T12:00:00Z",
          "view_trend_7d": [{"date": "2026-06-19", "views": 10}, {"date": "2026-06-20", "views": 18}]
        }
        """
        let r = try JSONDecoder().decode(ListingPerformanceRow.self, from: Data(json.utf8))
        XCTAssertEqual(r.id, "l1")
        XCTAssertEqual(r.inventoryItemId, "i1")
        XCTAssertEqual(r.listingTitle, "Vintage Jacket")
        XCTAssertEqual(r.listingURL, "https://ebay.com/itm/1")
        XCTAssertEqual(r.listingPrice, 42.5, accuracy: 0.001)
        XCTAssertEqual(r.viewsTotal, 120)
        XCTAssertEqual(r.watchersCount, 4)
        XCTAssertEqual(r.impressions7d, 800)
        XCTAssertEqual(r.clickThroughRate ?? -1, 0.15, accuracy: 0.001)
        XCTAssertEqual(r.viewTrend7d.count, 2)
        XCTAssertEqual(r.viewTrend7d.last?.views, 18)
    }

    func test_decode_tolerantOfNullMetrics() throws {
        // A row synced before any Sell Analytics pull ran: metrics null, no trend.
        let json = """
        {
          "id": "l2",
          "inventory_item_id": "i2",
          "listing_title": null,
          "listing_url": null,
          "listing_price": 19.99,
          "listed_at": null,
          "views_total": null,
          "watchers_count": null,
          "impressions_7d": null,
          "click_through_rate": null,
          "last_metrics_synced_at": null,
          "view_trend_7d": null
        }
        """
        let r = try JSONDecoder().decode(ListingPerformanceRow.self, from: Data(json.utf8))
        XCTAssertEqual(r.viewsTotal, 0)
        XCTAssertEqual(r.watchersCount, 0)
        XCTAssertEqual(r.impressions7d, 0)
        XCTAssertNil(r.clickThroughRate)
        XCTAssertTrue(r.viewTrend7d.isEmpty)
        XCTAssertNil(r.listingTitle)
    }
}
