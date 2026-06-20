import XCTest
@testable import GradeThread

/// US-816 — bulk price-suggestions surface: candidate selection, comps→
/// suggestion mapping, and the apply/dismiss store flow (optimistic +
/// revert-on-failure).
final class PriceSuggestionsTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func item(
        _ id: String, title: String = "Item", status: String = "cataloged",
        target: Double? = nil, listing: Double? = nil
    ) -> PriceSuggestionItemSnapshot {
        PriceSuggestionItemSnapshot(
            id: id, title: title, brand: nil, size: nil, status: status,
            targetPrice: target, listingPrice: listing
        )
    }

    private func listing(
        _ itemId: String, status: String = "active", price: Double = 25,
        daysAgo: Double? = nil
    ) -> PriceSuggestionListingSnapshot {
        PriceSuggestionListingSnapshot(
            inventoryItemId: itemId, listingStatus: status, listingPrice: price,
            listedAt: daysAgo.map { now.addingTimeInterval(-$0 * 86_400) }
        )
    }

    // MARK: - Candidate selection

    func test_noTargetPrice_isACandidate() {
        let c = PriceSuggestions.candidates(
            items: [item("a", target: nil)], listings: [], now: now)
        XCTAssertEqual(c.count, 1)
        XCTAssertEqual(c.first?.reason, .noTargetPrice)
    }

    func test_pricedAndFresh_isExcluded() {
        let c = PriceSuggestions.candidates(
            items: [item("a", target: 20)],
            listings: [listing("a", daysAgo: 3)], now: now)
        XCTAssertTrue(c.isEmpty)
    }

    func test_pricedButStaleListing_isACandidate() {
        let c = PriceSuggestions.candidates(
            items: [item("a", status: "listed", target: 20)],
            listings: [listing("a", price: 30, daysAgo: 45)], now: now)
        XCTAssertEqual(c.count, 1)
        XCTAssertEqual(c.first?.reason, .staleListing(days: 45))
        XCTAssertEqual(c.first?.currentPrice, 30)
    }

    func test_soldItem_isExcluded() {
        let c = PriceSuggestions.candidates(
            items: [item("a", status: "sold", target: nil)], listings: [], now: now)
        XCTAssertTrue(c.isEmpty)
    }

    func test_draftPresence_isFlagged() {
        let c = PriceSuggestions.candidates(
            items: [item("a", target: nil)],
            listings: [listing("a", status: "draft", price: 12)], now: now)
        XCTAssertEqual(c.first?.hasDraft, true)
    }

    func test_sortsNoPriceBeforeStale() {
        let c = PriceSuggestions.candidates(
            items: [
                item("stale", title: "B", status: "listed", target: 20),
                item("noprice", title: "A", target: nil),
            ],
            listings: [listing("stale", daysAgo: 60)], now: now)
        XCTAssertEqual(c.map(\.id), ["noprice", "stale"])
    }

    // MARK: - Comps → suggestion

    func test_suggestion_fromMedian() {
        let lookup = CompsLookup(
            stats: CompStats(count: 12, currency: "USD", min: 10, p25: 20,
                             median: 30, p75: 40, max: 55),
            categoryId: "1", categoryPath: "Clothing")
        let s = PriceSuggestion.from(lookup: lookup)
        XCTAssertEqual(s?.suggestedPrice, 30)
        XCTAssertEqual(s?.compCount, 12)
        XCTAssertEqual(s?.low, 20)
        XCTAssertEqual(s?.high, 40)
    }

    func test_suggestion_nilWhenNoComps() {
        let lookup = CompsLookup(
            stats: CompStats(count: 0, currency: "USD", min: nil, p25: nil,
                             median: nil, p75: nil, max: nil),
            categoryId: "1", categoryPath: "Clothing")
        XCTAssertNil(PriceSuggestion.from(lookup: lookup))
    }

    // MARK: - Store flow

    @MainActor
    private func makeCandidate(_ id: String, title: String, hasDraft: Bool = false) -> PriceSuggestionCandidate {
        PriceSuggestionCandidate(
            id: id, title: title, brand: nil, size: nil, currentPrice: 25,
            hasDraft: hasDraft, reason: .noTargetPrice)
    }

    @MainActor
    func test_scan_populatesSuggestions() async {
        let comps = FakeComps()
        comps.byTitle["Nike Hoodie"] = lookup(median: 30, count: 8)
        let store = PriceSuggestionsStore(
            comps: comps, applier: FakeApplier(), throttle: .zero)

        await store.start(candidates: [makeCandidate("a", title: "Nike Hoodie")])

        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.rows.first?.state, .suggested)
        XCTAssertEqual(store.rows.first?.suggestion?.suggestedPrice, 30)
    }

    @MainActor
    func test_scan_noCompsMarksRow() async {
        let comps = FakeComps()  // returns nil for any title
        let store = PriceSuggestionsStore(
            comps: comps, applier: FakeApplier(), throttle: .zero)
        await store.start(candidates: [makeCandidate("a", title: "Mystery")])
        XCTAssertEqual(store.rows.first?.state, .noComps)
    }

    @MainActor
    func test_apply_writesPriceAndHidesRow() async {
        let comps = FakeComps()
        comps.byTitle["Hat"] = lookup(median: 18, count: 5)
        let applier = FakeApplier()
        let store = PriceSuggestionsStore(comps: comps, applier: applier, throttle: .zero)
        await store.start(candidates: [makeCandidate("a", title: "Hat", hasDraft: true)])

        guard let row = store.visibleRows.first else { return XCTFail("no row") }
        await store.apply(row)

        XCTAssertEqual(applier.applied.count, 1)
        XCTAssertEqual(applier.applied.first?.0, "a")
        XCTAssertEqual(applier.applied.first?.1, 18)
        XCTAssertEqual(applier.applied.first?.2, true)   // updateDraft passed through
        XCTAssertEqual(store.rows.first?.state, .applied)
        XCTAssertTrue(store.visibleRows.isEmpty)
    }

    @MainActor
    func test_apply_revertsOnFailure() async {
        let comps = FakeComps()
        comps.byTitle["Hat"] = lookup(median: 18, count: 5)
        let applier = FakeApplier()
        applier.shouldThrow = true
        let store = PriceSuggestionsStore(comps: comps, applier: applier, throttle: .zero)
        await store.start(candidates: [makeCandidate("a", title: "Hat")])

        guard let row = store.visibleRows.first else { return XCTFail("no row") }
        await store.apply(row)

        XCTAssertEqual(store.rows.first?.state, .suggested)   // reverted
        XCTAssertNotNil(store.actionError)
        XCTAssertNotNil(store.error(for: row))
    }

    @MainActor
    func test_dismiss_hidesRow() async {
        let comps = FakeComps()
        comps.byTitle["Hat"] = lookup(median: 18, count: 5)
        let store = PriceSuggestionsStore(comps: comps, applier: FakeApplier(), throttle: .zero)
        await store.start(candidates: [makeCandidate("a", title: "Hat")])

        guard let row = store.visibleRows.first else { return XCTFail("no row") }
        store.dismiss(row)
        XCTAssertTrue(store.visibleRows.isEmpty)
        XCTAssertEqual(store.rows.first?.state, .dismissed)
    }

    private func lookup(median: Double, count: Int) -> CompsLookup {
        CompsLookup(
            stats: CompStats(count: count, currency: "USD", min: median - 5,
                             p25: median - 3, median: median, p75: median + 3,
                             max: median + 5),
            categoryId: "1", categoryPath: "Clothing")
    }
}

// MARK: - Fakes

@MainActor
private final class FakeComps: CompsProviding {
    var byTitle: [String: CompsLookup] = [:]
    var throwTitles: Set<String> = []
    func lookup(title: String, brand: String?, size: String?) async throws -> CompsLookup? {
        if throwTitles.contains(title) { throw EdgeAPIError.network("boom") }
        return byTitle[title]
    }
}

@MainActor
private final class FakeApplier: PriceSuggestionApplying {
    var applied: [(String, Double, Bool)] = []
    var shouldThrow = false
    func apply(itemId: String, price: Double, updateDraft: Bool) async throws {
        if shouldThrow { throw EdgeAPIError.network("nope") }
        applied.append((itemId, price, updateDraft))
    }
}
