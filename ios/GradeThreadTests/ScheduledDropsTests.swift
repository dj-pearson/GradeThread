import XCTest
@testable import GradeThread

/// US-1127 — native Scheduled Drops: wire decode + title/promoted derivation,
/// the timezone-aware preset scheduling (port of `src/lib/scheduling.ts`), and
/// the store (load / reschedule / cancel) via a faked service.
final class ScheduledDropsTests: XCTestCase {

    // MARK: - Decode

    func test_decode_dropRow_titleFallbackAndPromoted() throws {
        let json = """
        {"id":"l1","inventory_item_id":"i1","listing_title":"  ","listing_price":24.99,
         "scheduled_publish_at":"2026-06-21T19:00:00Z","promo_opt_out":false,
         "promo_rate_pct":3,"inventory_items":{"title":"Wool coat"}}
        """.data(using: .utf8)!
        let row = try JSONDecoder().decode(ScheduledDropRow.self, from: json)
        let drop = try XCTUnwrap(ScheduledDrop(row: row))
        // Blank listing_title falls back to the item title.
        XCTAssertEqual(drop.title, "Wool coat")
        XCTAssertEqual(drop.priceDollars ?? 0, 24.99, accuracy: 0.001)
        XCTAssertTrue(drop.isPromoted)
        XCTAssertEqual(drop.promoRatePct, 3)
    }

    func test_decode_dropRow_notPromotedWhenOptedOut() throws {
        let json = """
        {"id":"l2","inventory_item_id":"i2","listing_title":"Nike tee","listing_price":null,
         "scheduled_publish_at":"2026-06-21T19:00:00.123Z","promo_opt_out":true,
         "promo_rate_pct":5,"inventory_items":null}
        """.data(using: .utf8)!
        let row = try JSONDecoder().decode(ScheduledDropRow.self, from: json)
        let drop = try XCTUnwrap(ScheduledDrop(row: row))
        XCTAssertEqual(drop.title, "Nike tee")
        XCTAssertNil(drop.priceDollars)
        XCTAssertFalse(drop.isPromoted)   // opted out
    }

    func test_decode_dropRow_placeholderTitleWhenAllBlank() throws {
        let json = """
        {"id":"l3","inventory_item_id":"i3","listing_title":null,"listing_price":10,
         "scheduled_publish_at":"2026-06-21T19:00:00Z","promo_opt_out":null,
         "promo_rate_pct":null,"inventory_items":{"title":null}}
        """.data(using: .utf8)!
        let row = try JSONDecoder().decode(ScheduledDropRow.self, from: json)
        let drop = try XCTUnwrap(ScheduledDrop(row: row))
        XCTAssertEqual(drop.title, "Untitled draft")
        XCTAssertFalse(drop.isPromoted)
    }

    func test_decode_dropRow_invalidTimestampDropped() throws {
        let json = """
        {"id":"l4","inventory_item_id":"i4","listing_title":"X","listing_price":1,
         "scheduled_publish_at":"not-a-date","promo_opt_out":false,
         "promo_rate_pct":null,"inventory_items":null}
        """.data(using: .utf8)!
        let row = try JSONDecoder().decode(ScheduledDropRow.self, from: json)
        XCTAssertNil(ScheduledDrop(row: row))
    }

    // MARK: - Timestamp parsing

    func test_parseTimestamp_fractionalAndPlain() {
        XCTAssertNotNil(ScheduledDropScheduling.parseTimestamp("2026-06-21T19:00:00.123Z"))
        XCTAssertNotNil(ScheduledDropScheduling.parseTimestamp("2026-06-21T19:00:00Z"))
        XCTAssertNil(ScheduledDropScheduling.parseTimestamp("garbage"))
    }

    // MARK: - Scheduling

    private func components(_ date: Date, zone: String) -> DateComponents {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: zone)!
        return cal.dateComponents([.weekday, .hour, .minute], from: date)
    }

    func test_nextPresetDate_weekdayLandsOnSundayEvening() {
        // A Wednesday: 2026-06-17 12:00 UTC.
        let from = ScheduledDropScheduling.parseTimestamp("2026-06-17T12:00:00Z")!
        let sunday7pm = ScheduledDropScheduling.presets.first { $0.id == "sun-7pm" }!
        let next = ScheduledDropScheduling.nextPresetDate(sunday7pm, timeZoneIdentifier: "America/Chicago", from: from)
        let parts = components(next, zone: "America/Chicago")
        XCTAssertEqual(parts.weekday, 1)   // Sunday
        XCTAssertEqual(parts.hour, 19)     // 7 PM local
        XCTAssertEqual(parts.minute, 0)
        XCTAssertGreaterThan(next, from)
    }

    func test_nextPresetDate_dayAgnosticPicksNextSevenPM() {
        // 2026-06-17 20:00 UTC = 15:00 Chicago, so today's 7 PM is still future.
        let from = ScheduledDropScheduling.parseTimestamp("2026-06-17T20:00:00Z")!
        let tonight = ScheduledDropScheduling.presets.first { $0.id == "tonight-7pm" }!
        let next = ScheduledDropScheduling.nextPresetDate(tonight, timeZoneIdentifier: "America/Chicago", from: from)
        let parts = components(next, zone: "America/Chicago")
        XCTAssertEqual(parts.hour, 19)
        XCTAssertGreaterThan(next, from)
        // Within 24h since today's slot was still ahead.
        XCTAssertLessThan(next.timeIntervalSince(from), 24 * 60 * 60)
    }

    // MARK: - Fake

    final class FakeService: ScheduledDropsProviding {
        var drops: [ScheduledDrop]
        var listError: Error?
        var rescheduleError: Error?
        var cancelError: Error?
        private(set) var rescheduled: [(String, Date)] = []
        private(set) var cancelled: [String] = []

        init(drops: [ScheduledDrop] = []) { self.drops = drops }

        func list() async throws -> [ScheduledDrop] {
            if let listError { throw listError }
            return drops
        }
        func reschedule(listingId: String, to date: Date) async throws {
            if let rescheduleError { throw rescheduleError }
            rescheduled.append((listingId, date))
        }
        func cancel(listingId: String) async throws {
            if let cancelError { throw cancelError }
            cancelled.append(listingId)
        }
    }

    private func drop(_ id: String, at iso: String, promoted: Bool = false) -> ScheduledDrop {
        ScheduledDrop(
            id: id,
            inventoryItemId: "item-\(id)",
            title: "Drop \(id)",
            priceDollars: 20,
            scheduledPublishAt: ScheduledDropScheduling.parseTimestamp(iso)!,
            isPromoted: promoted,
            promoRatePct: promoted ? 3 : nil
        )
    }

    // MARK: - Store

    @MainActor
    func test_load_populatesDrops() async {
        let fake = FakeService(drops: [drop("a", at: "2026-06-21T19:00:00Z")])
        let store = ScheduledDropsStore(service: fake, timeZoneIdentifier: "America/Chicago")
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.drops.map(\.id), ["a"])
    }

    @MainActor
    func test_load_failureSetsFailedPhase() async {
        let fake = FakeService()
        fake.listError = EdgeAPIError.rateLimited
        let store = ScheduledDropsStore(service: fake, timeZoneIdentifier: "UTC")
        await store.load()
        if case .failed = store.phase {} else { XCTFail("expected failed phase") }
    }

    @MainActor
    func test_reschedule_updatesAndReSorts() async {
        let fake = FakeService(drops: [
            drop("a", at: "2026-06-21T19:00:00Z"),
            drop("b", at: "2026-06-22T19:00:00Z"),
        ])
        let store = ScheduledDropsStore(service: fake, timeZoneIdentifier: "UTC")
        await store.load()
        // Move "a" to after "b".
        let later = ScheduledDropScheduling.parseTimestamp("2026-06-23T19:00:00Z")!
        await store.reschedule(store.drops[0], to: later)
        XCTAssertEqual(store.drops.map(\.id), ["b", "a"])   // re-sorted
        XCTAssertEqual(fake.rescheduled.first?.0, "a")
        XCTAssertEqual(store.actionBanner, "Drop rescheduled.")
    }

    @MainActor
    func test_reschedule_failureSurfacesError() async {
        let fake = FakeService(drops: [drop("a", at: "2026-06-21T19:00:00Z")])
        fake.rescheduleError = EdgeAPIError.rateLimited
        let store = ScheduledDropsStore(service: fake, timeZoneIdentifier: "UTC")
        await store.load()
        let original = store.drops[0].scheduledPublishAt
        await store.reschedule(store.drops[0], to: original.addingTimeInterval(3600))
        XCTAssertNotNil(store.actionError)
        XCTAssertEqual(store.drops[0].scheduledPublishAt, original)   // unchanged
    }

    @MainActor
    func test_cancel_optimisticRemovesAndRecords() async {
        let fake = FakeService(drops: [drop("a", at: "2026-06-21T19:00:00Z")])
        let store = ScheduledDropsStore(service: fake, timeZoneIdentifier: "UTC")
        await store.load()
        await store.cancel(store.drops[0])
        XCTAssertTrue(store.drops.isEmpty)
        XCTAssertEqual(fake.cancelled, ["a"])
    }

    @MainActor
    func test_cancel_failureRestores() async {
        let fake = FakeService(drops: [drop("a", at: "2026-06-21T19:00:00Z")])
        fake.cancelError = EdgeAPIError.rateLimited
        let store = ScheduledDropsStore(service: fake, timeZoneIdentifier: "UTC")
        await store.load()
        await store.cancel(store.drops[0])
        XCTAssertEqual(store.drops.map(\.id), ["a"])   // restored
        XCTAssertNotNil(store.actionError)
    }
}
