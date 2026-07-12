import XCTest
@testable import GradeThread

@MainActor
final class RepricingTests: XCTestCase {

    private func snakeDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    // MARK: - Decoding

    func test_decodesSuggestion_fromJoinedRow() throws {
        let json = #"""
        {"suggestions":[
          {"id":"s1","inventory_item_id":"i1","listing_id":"l1",
           "current_price_cents":4500,"suggested_price_cents":3800,
           "comp_median_cents":3900,"comp_count":14,"condition_id":"3000",
           "reason_code":"OVERPRICED","message":"Priced above comps","confidence":0.81,
           "status":"pending","updated_at":"2026-06-06T00:00:00Z",
           "inventory_items":{"title":"Nike Hoodie","brand":"Nike","grade_value":8.0,"grade_label":"Excellent"},
           "listings":{"listing_status":"active","listing_url":"https://ebay/1"}}
        ]}
        """#
        let r = try snakeDecoder().decode(RepricingSuggestionsResponse.self, from: Data(json.utf8))
        let s = try XCTUnwrap(r.suggestions.first)
        XCTAssertEqual(s.id, "s1")
        XCTAssertEqual(s.currentPriceCents, 4500)
        XCTAssertEqual(s.suggestedPriceCents, 3800)
        XCTAssertEqual(s.reason, .overpriced)
        XCTAssertEqual(s.inventoryItems.brand, "Nike")
        XCTAssertEqual(s.inventoryItems.gradeValue, 8.0)
        XCTAssertEqual(s.listings.listingUrl, "https://ebay/1")
        XCTAssertEqual(s.deltaCents, -700)
        XCTAssertEqual(try XCTUnwrap(s.deltaPct), -700.0 / 4500.0, accuracy: 0.0001)
    }

    func test_decodesApplyResponse() throws {
        let json = #"{"applied":true,"new_price":38.0,"ebay_synced":true}"#
        let r = try snakeDecoder().decode(RepricingApplyResponse.self, from: Data(json.utf8))
        XCTAssertTrue(r.applied)
        XCTAssertEqual(r.newPrice, 38.0)
        XCTAssertEqual(r.ebaySynced, true)
    }

    // MARK: - Derived

    func test_reasonMapping_unknownFallsBackToOther() {
        XCTAssertEqual(RepricingReason(code: "UNDERPRICED"), .underpriced)
        XCTAssertEqual(RepricingReason(code: "WAT"), .other)
    }

    func test_title_fallsBackWhenBlank() {
        let s = makeSuggestion(id: "x", title: "   ")
        XCTAssertEqual(s.title, "Untitled item")
    }

    // MARK: - Summary

    func test_summary_countsAndOrders() {
        let items = [
            makeSuggestion(id: "a", reason: "STALE"),
            makeSuggestion(id: "b", reason: "UNDERPRICED"),
            makeSuggestion(id: "c", reason: "UNDERPRICED"),
            makeSuggestion(id: "d", reason: "OVERPRICED"),
        ]
        let summary = RepricingStore.summary(items)
        XCTAssertEqual(summary.map(\.reason), [.underpriced, .overpriced, .stale])
        XCTAssertEqual(summary.first?.count, 2)
    }

    // MARK: - Store flows

    func test_load_success_setsLoaded() async {
        let store = RepricingStore(service: FakeRepricingService(suggestions: [makeSuggestion(id: "a")]))
        await store.load()
        XCTAssertEqual(store.phase, .loaded)
        XCTAssertEqual(store.suggestions.count, 1)
    }

    func test_load_failure_whenEmpty_setsFailed() async {
        let fake = FakeRepricingService(suggestions: [])
        fake.suggestionsError = EdgeAPIError.serverError(detail: "boom")
        let store = RepricingStore(service: fake)
        await store.load()
        guard case .failed = store.phase else {
            return XCTFail("expected .failed, got \(store.phase)")
        }
    }

    func test_apply_removesRow_andSetsBanner() async {
        let s = makeSuggestion(id: "a")
        let fake = FakeRepricingService(suggestions: [s])
        let store = RepricingStore(service: fake)
        await store.load()
        await store.apply(s)
        XCTAssertTrue(store.suggestions.isEmpty)
        XCTAssertTrue(store.inFlight.isEmpty)
        XCTAssertNotNil(store.banner)
        XCTAssertNil(store.rowErrors["a"])
    }

    func test_apply_withoutServerPrice_bannerHasNoFalseZero() async {
        let s = makeSuggestion(id: "a")
        let fake = FakeRepricingService(suggestions: [s])
        fake.applyPrice = nil            // server confirmed the apply, echoed no price
        let store = RepricingStore(service: fake)
        await store.load()
        await store.apply(s)
        XCTAssertEqual(store.banner, "Reprice applied.")   // NOT "Repriced to $0.00."
        XCTAssertNil(store.rowErrors["a"])
    }

    func test_apply_failure_keepsRow_andSetsRowError() async {
        let s = makeSuggestion(id: "a")
        let fake = FakeRepricingService(suggestions: [s])
        fake.applyError = RepricingError.applyFailed("eBay rejected the update")
        let store = RepricingStore(service: fake)
        await store.load()
        await store.apply(s)
        XCTAssertEqual(store.suggestions.count, 1, "row stays so it's retryable")
        XCTAssertEqual(store.rowErrors["a"], "eBay rejected the update")
    }

    func test_dismiss_removesRow() async {
        let s = makeSuggestion(id: "a")
        let store = RepricingStore(service: FakeRepricingService(suggestions: [s]))
        await store.load()
        await store.dismiss(s)
        XCTAssertTrue(store.suggestions.isEmpty)
    }

    // MARK: - Helpers

    private func makeSuggestion(
        id: String,
        title: String = "Item",
        reason: String = "UNDERPRICED",
        current: Int = 2000,
        suggested: Int = 2500
    ) -> RepricingSuggestion {
        RepricingSuggestion(
            id: id,
            currentPriceCents: current,
            suggestedPriceCents: suggested,
            compMedianCents: 2400,
            compCount: 10,
            reasonCode: reason,
            message: "msg",
            confidence: 0.8,
            inventoryItems: .init(title: title, brand: "Nike", gradeValue: 8, gradeLabel: "Excellent"),
            listings: .init(listingUrl: "https://ebay/x")
        )
    }
}

@MainActor
private final class FakeRepricingService: RepricingProviding {
    var suggestionsList: [RepricingSuggestion]
    var suggestionsError: Error?
    var applyError: Error?
    /// Price the fake `apply` echoes; nil simulates the server confirming the
    /// apply without a price (must not render as "$0.00").
    var applyPrice: Double? = 25.0
    var dismissError: Error?

    init(suggestions: [RepricingSuggestion]) {
        self.suggestionsList = suggestions
    }

    func suggestions() async throws -> [RepricingSuggestion] {
        if let suggestionsError { throw suggestionsError }
        return suggestionsList
    }

    func apply(id: String) async throws -> Double? {
        if let applyError { throw applyError }
        return applyPrice
    }

    func dismiss(id: String) async throws {
        if let dismissError { throw dismissError }
    }

    func scan() async throws -> RepricingScanResult {
        RepricingScanResult(scanned: 3, actionable: 1)
    }
}
