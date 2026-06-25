import XCTest
@testable import GradeThread

/// US-190 — exercises the pure widget rollup math + the Codable
/// round-trip. The App Group write/read path isn't tested here (no
/// container in the unit-test sandbox); WidgetSnapshotStore.write
/// returns false in that environment by design.
final class WidgetSnapshotTests: XCTestCase {

    // MARK: - compute()

    func test_compute_signedOut_returnsSignedOutSnapshot() {
        let snapshot = WidgetSnapshotPublisher.compute(
            listings: [makeListing(status: "active")],
            sales: [makeSale(price: 50, date: .now)],
            now: .now,
            isSignedIn: false
        )
        XCTAssertFalse(snapshot.isSignedIn)
        XCTAssertEqual(snapshot.activeListings, 0)
        XCTAssertEqual(snapshot.soldTodayCount, 0)
        XCTAssertEqual(snapshot.pendingPayoutNet, 0)
    }

    func test_compute_countsOnlyActiveListings() {
        let listings = [
            makeListing(status: "active"),
            makeListing(status: "active"),
            makeListing(status: "draft"),
            makeListing(status: "ended"),
            makeListing(status: "sold"),
        ]
        let snapshot = WidgetSnapshotPublisher.compute(
            listings: listings, sales: [], now: .now, isSignedIn: true
        )
        XCTAssertEqual(snapshot.activeListings, 2)
    }

    func test_compute_countsRelistedAndIsCaseInsensitive() {
        // US-1258: relisted is still live, and casing drift must not zero the tile.
        let listings = [
            makeListing(status: "active"),
            makeListing(status: "relisted"),
            makeListing(status: "ACTIVE"),
            makeListing(status: "ended"),
        ]
        let snapshot = WidgetSnapshotPublisher.compute(
            listings: listings, sales: [], now: .now, isSignedIn: true
        )
        XCTAssertEqual(snapshot.activeListings, 3)
    }

    func test_compute_soldToday_bucketsByStartOfDay() {
        let cal = Calendar(identifier: .gregorian)
        let now = Date(timeIntervalSince1970: 1_700_000_000) // fixed instant
        let startOfToday = cal.startOfDay(for: now)
        let sales = [
            makeSale(price: 30, date: startOfToday),                              // today (boundary)
            makeSale(price: 70, date: now),                                       // today
            makeSale(price: 999, date: startOfToday.addingTimeInterval(-1)),      // yesterday
        ]
        let snapshot = WidgetSnapshotPublisher.compute(
            listings: [], sales: sales, now: now, isSignedIn: true, calendar: cal
        )
        XCTAssertEqual(snapshot.soldTodayCount, 2)
        XCTAssertEqual(snapshot.soldTodayGross, 100, accuracy: 0.001)
    }

    func test_compute_pendingPayout_excludesPaidOutSales() {
        let now = Date()
        let paid = makeSale(price: 100, date: now, fees: 13)
        paid.payoutReference = "PAYOUT-123"
        let pendingA = makeSale(price: 80, date: now, fees: 10)   // net 70
        let pendingB = makeSale(price: 50, date: now, fees: 5)    // net 45
        let snapshot = WidgetSnapshotPublisher.compute(
            listings: [], sales: [paid, pendingA, pendingB], now: now, isSignedIn: true
        )
        XCTAssertEqual(snapshot.pendingPayoutCount, 2)
        XCTAssertEqual(snapshot.pendingPayoutNet, 115, accuracy: 0.001)
    }

    func test_compute_pendingPayout_emptyReferenceCountsAsPending() {
        let sale = makeSale(price: 40, date: .now, fees: 4)
        sale.payoutReference = ""   // empty string, not nil
        let snapshot = WidgetSnapshotPublisher.compute(
            listings: [], sales: [sale], now: .now, isSignedIn: true
        )
        XCTAssertEqual(snapshot.pendingPayoutCount, 1)
        XCTAssertEqual(snapshot.pendingPayoutNet, 36, accuracy: 0.001)
    }

    func test_compute_payoutNeverNegative_whenFeesExceedPrice() {
        // Bad data: fees > sale price. Net floors at zero rather than
        // dragging the payout total negative.
        let sale = makeSale(price: 10, date: .now, fees: 25)
        let snapshot = WidgetSnapshotPublisher.compute(
            listings: [], sales: [sale], now: .now, isSignedIn: true
        )
        XCTAssertEqual(snapshot.pendingPayoutNet, 0, accuracy: 0.001)
    }

    func test_compute_emptyData_signedIn_isAllZeros() {
        let snapshot = WidgetSnapshotPublisher.compute(
            listings: [], sales: [], now: .now, isSignedIn: true
        )
        XCTAssertTrue(snapshot.isSignedIn)   // distinct from signedOut
        XCTAssertEqual(snapshot.activeListings, 0)
        XCTAssertEqual(snapshot.soldTodayCount, 0)
        XCTAssertEqual(snapshot.pendingPayoutCount, 0)
    }

    // MARK: - Codable round-trip

    func test_codable_roundTrips() throws {
        let original = WidgetSnapshot(
            generatedAt: Date(timeIntervalSince1970: 1_700_000_000),
            isSignedIn: true,
            activeListings: 12,
            soldTodayCount: 3,
            soldTodayGross: 184.5,
            pendingPayoutCount: 5,
            pendingPayoutNet: 312.55
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(original)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(WidgetSnapshot.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    func test_signedOutFactory_matchesIsSignedInFalse() {
        XCTAssertFalse(WidgetSnapshot.signedOut().isSignedIn)
        XCTAssertEqual(WidgetSnapshot.signedOut().pendingPayoutNet, 0)
    }

    // MARK: - Helpers

    private func makeListing(status: String) -> LocalListing {
        LocalListing(
            id: UUID().uuidString,
            inventoryItemId: UUID().uuidString,
            platform: "ebay",
            listingPrice: 25,
            listingStatus: status
        )
    }

    private func makeSale(price: Double, date: Date, fees: Double = 0) -> LocalSale {
        LocalSale(
            id: UUID().uuidString,
            inventoryItemId: UUID().uuidString,
            salePrice: price,
            saleDate: date,
            platformFees: fees
        )
    }
}
