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

    /// US-3302: the zone is PINNED. `Calendar(identifier:)` picks up the
    /// runner's own zone, and the runner's zone is UTC, so this case could only
    /// ever have exercised the one arrangement where a local `startOfDay` and a
    /// UTC anchor are the same instant. See
    /// ``MoneyMonthBucketTests`` for the Chicago case it could not see.
    func test_compute_soldToday_bucketsByStartOfDay() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
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

    // MARK: - US-3226 soldTodayIsStale

    /// A phone left alone overnight showed the previous day's "sold today"
    /// figure as this morning's. The widget entry at local midnight now asks
    /// the snapshot whether that pair still describes today.
    func test_soldTodayIsStale_falseWithinTheSameLocalDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago") ?? .current
        let morning = calendar.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 8))!
        let evening = calendar.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 23, minute: 59))!
        let snapshot = makeSnapshot(generatedAt: morning)

        XCTAssertFalse(snapshot.soldTodayIsStale(asOf: morning, calendar: calendar))
        XCTAssertFalse(snapshot.soldTodayIsStale(asOf: evening, calendar: calendar))
    }

    func test_soldTodayIsStale_trueOnceLocalMidnightPasses() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago") ?? .current
        let lastNight = calendar.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 22))!
        let justAfterMidnight = calendar.date(from: DateComponents(year: 2026, month: 9, day: 10, hour: 0, minute: 1))!
        let snapshot = makeSnapshot(generatedAt: lastNight)

        XCTAssertTrue(snapshot.soldTodayIsStale(asOf: justAfterMidnight, calendar: calendar))
    }

    /// Two hours apart is not stale; two hours apart ACROSS midnight is. The
    /// test that would pass with an elapsed-time check instead of a calendar-day
    /// one.
    func test_soldTodayIsStale_isADayBoundaryNotADuration() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago") ?? .current
        let elevenPM = calendar.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 23))!
        let onePM = calendar.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 13))!
        let oneAM = calendar.date(from: DateComponents(year: 2026, month: 9, day: 10, hour: 1))!

        XCTAssertFalse(makeSnapshot(generatedAt: onePM).soldTodayIsStale(asOf: elevenPM, calendar: calendar))
        XCTAssertTrue(makeSnapshot(generatedAt: elevenPM).soldTodayIsStale(asOf: oneAM, calendar: calendar))
    }

    private func makeSnapshot(generatedAt: Date) -> WidgetSnapshot {
        WidgetSnapshot(
            generatedAt: generatedAt,
            isSignedIn: true,
            activeListings: 12,
            soldTodayCount: 3,
            soldTodayGross: 214,
            pendingPayoutCount: 2,
            pendingPayoutNet: 180
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
