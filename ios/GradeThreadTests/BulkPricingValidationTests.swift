import XCTest
@testable import GradeThread

/// US-1220: bulk-pricing reduce-mode bounds + computed-price floor.
@MainActor
final class BulkPricingValidationTests: XCTestCase {

    // MARK: - Pure computed-price floor (validatedTargetPrice)

    func test_setMode_positiveAmount_isValid() {
        let r = BulkPricingStore.validatedTargetPrice(base: 100, mode: .set, percentOrAmount: 25)
        XCTAssertEqual(r.price, 25)
        XCTAssertNil(r.error)
    }

    func test_reduceMode_normalPercent_computesPrice() {
        let r = BulkPricingStore.validatedTargetPrice(base: 100, mode: .reduce, percentOrAmount: 30)
        XCTAssertEqual(r.price, 70)
        XCTAssertNil(r.error)
    }

    func test_reduceMode_hundredPercent_isBlockedWithReason() {
        // 100% reduction zeroes the price → blocked client-side, not sent.
        let r = BulkPricingStore.validatedTargetPrice(base: 50, mode: .reduce, percentOrAmount: 100)
        XCTAssertNil(r.price)
        XCTAssertNotNil(r.error)
    }

    func test_reduceMode_deepReduceOnCheapItem_floorsOut() {
        // 99% off a $0.40 item rounds below $0.01 → blocked with a row reason.
        let r = BulkPricingStore.validatedTargetPrice(base: 0.40, mode: .reduce, percentOrAmount: 99)
        XCTAssertNil(r.price)
        XCTAssertNotNil(r.error)
    }

    // MARK: - Input-level validation (priceActive / priceInputError)

    func test_reduceMode_outOfRangeInput_deactivatesAndExplains() {
        let store = BulkPricingStore()
        store.priceMode = .reduce

        store.priceText = "100"
        XCTAssertFalse(store.priceActive)             // 100% is not appliable
        XCTAssertNotNil(store.priceInputError)

        store.priceText = "150"
        XCTAssertFalse(store.priceActive)
        XCTAssertNotNil(store.priceInputError)

        store.priceText = "25"
        XCTAssertTrue(store.priceActive)              // a real reduction is fine
        XCTAssertNil(store.priceInputError)
    }

    func test_setMode_zeroOrNegative_blocked() {
        let store = BulkPricingStore()
        store.priceMode = .set
        store.priceText = "0"
        XCTAssertFalse(store.priceActive)
        XCTAssertNotNil(store.priceInputError)
    }

    // MARK: - US-1216: account-context banner (multi-store safety)

    /// Fake provider so the store's account-context resolution can be exercised
    /// without a live Supabase/edge.
    private struct FakeProvider: BulkPricingProviding {
        var accounts: [BulkPricingAccount]
        func listings() async throws -> [BulkListing] { [] }
        func apply(updates: [BulkPriceQtyUpdate]) async throws -> BulkPriceQtyResponse {
            BulkPriceQtyResponse(results: [], succeeded: 0, total: 0)
        }
        func ebayAccounts() async throws -> [BulkPricingAccount] { accounts }
    }

    func test_singleAccount_noBannerAndNoMixingHint() async {
        let store = BulkPricingStore(service: FakeProvider(accounts: [
            BulkPricingAccount(id: "a", displayName: "Main Store", isPrimary: true),
        ]))
        await store.load()
        XCTAssertFalse(store.hasMultipleAccounts)
        XCTAssertEqual(store.primaryAccountName, "Main Store")
    }

    func test_multipleAccounts_namesPrimaryStore() async {
        let store = BulkPricingStore(service: FakeProvider(accounts: [
            BulkPricingAccount(id: "p", displayName: "Closet A", isPrimary: true),
            BulkPricingAccount(id: "s", displayName: "Closet B", isPrimary: false),
        ]))
        await store.load()
        XCTAssertTrue(store.hasMultipleAccounts)
        // The named target is the PRIMARY store the edge bulk endpoint pushes
        // through — not merely the first row.
        XCTAssertEqual(store.primaryAccountName, "Closet A")
    }

    // MARK: - US-1167 (AC2): suggest from comps

    /// Pure median→suggested-price mapping.
    func test_suggestedPrice_usesMedianWhenCompsExist() {
        let stats = CompStats(count: 8, currency: "USD", min: 20, p25: 30, median: 52.5, p75: 70, max: 90)
        XCTAssertEqual(BulkPricingStore.suggestedPrice(from: stats), 52.5)
    }

    func test_suggestedPrice_nilWhenNoComps() {
        let empty = CompStats(count: 0, currency: "USD", min: nil, p25: nil, median: nil, p75: nil, max: nil)
        XCTAssertNil(BulkPricingStore.suggestedPrice(from: empty))
        let noMedian = CompStats(count: 3, currency: "USD", min: 5, p25: nil, median: nil, p75: nil, max: 20)
        XCTAssertNil(BulkPricingStore.suggestedPrice(from: noMedian))
    }

    func test_suggestFromComps_prefillsPerRowSuggestions() async {
        let rows = [
            BulkListing(id: "1", title: "Levi's 501", price: 40, quantity: 1),
            BulkListing(id: "2", title: "Nike Tee", price: 15, quantity: 1),
        ]
        let comps = FakeComps(byTitle: [
            "Levi's 501": Self.lookup(median: 52.5),
            "Nike Tee": Self.emptyLookup,   // category resolves, but zero comps
        ])
        let store = BulkPricingStore(service: FakeBulkProvider(rows: rows), comps: comps)
        await store.load()
        store.priceMode = .suggestFromComps
        store.selected = ["1", "2"]

        await store.suggestFromComps()

        XCTAssertEqual(store.suggestedPrice(for: "1"), 52.5)
        XCTAssertNil(store.suggestedPrice(for: "2"))
        XCTAssertTrue(store.priceActive)        // at least one suggestion exists
        XCTAssertTrue(store.canApply)
    }

    func test_apply_usesSuggestedPricesInCompsMode() async {
        let rows = [BulkListing(id: "1", title: "Levi's 501", price: 40, quantity: 1)]
        let provider = FakeBulkProvider(rows: rows)
        let store = BulkPricingStore(
            service: provider,
            comps: FakeComps(byTitle: ["Levi's 501": Self.lookup(median: 52.5)]))
        await store.load()
        store.priceMode = .suggestFromComps
        store.selected = ["1"]
        await store.suggestFromComps()

        await store.apply()

        XCTAssertEqual(provider.applied.count, 1)
        XCTAssertEqual(provider.applied.first?.price, 52.5)
    }

    func test_changingMode_clearsSuggestions() async {
        let rows = [BulkListing(id: "1", title: "Levi's 501", price: 40, quantity: 1)]
        let store = BulkPricingStore(
            service: FakeBulkProvider(rows: rows),
            comps: FakeComps(byTitle: ["Levi's 501": Self.lookup(median: 52.5)]))
        await store.load()
        store.priceMode = .suggestFromComps
        store.selected = ["1"]
        await store.suggestFromComps()
        XCTAssertNotNil(store.suggestedPrice(for: "1"))

        store.priceMode = .set     // switching modes drops stale suggestions
        XCTAssertNil(store.suggestedPrice(for: "1"))
    }

    private static func lookup(median: Double) -> CompsLookup? {
        CompsLookup(
            stats: CompStats(count: 6, currency: "USD", min: 20, p25: 30, median: median, p75: 70, max: 90),
            categoryId: "1", categoryPath: "Clothing › Test")
    }

    /// A resolved category whose comps query came back empty (count 0).
    private static let emptyLookup: CompsLookup? = CompsLookup(
        stats: CompStats(count: 0, currency: "USD", min: nil, p25: nil, median: nil, p75: nil, max: nil),
        categoryId: "1", categoryPath: "Clothing › Test")
}

/// Capturing fake for the bulk data layer so apply payloads can be asserted.
@MainActor
private final class FakeBulkProvider: BulkPricingProviding {
    let rows: [BulkListing]
    private(set) var applied: [BulkPriceQtyUpdate] = []
    init(rows: [BulkListing]) { self.rows = rows }
    func listings() async throws -> [BulkListing] { rows }
    func apply(updates: [BulkPriceQtyUpdate]) async throws -> BulkPriceQtyResponse {
        applied = updates
        return BulkPriceQtyResponse(
            results: updates.map { BulkPriceQtyResult(listingId: $0.listingId, ok: true, error: nil) },
            succeeded: updates.count, total: updates.count)
    }
    func ebayAccounts() async throws -> [BulkPricingAccount] { [] }
}

/// Deterministic comps lookup keyed by title (no network).
@MainActor
private final class FakeComps: CompsProviding {
    let byTitle: [String: CompsLookup?]
    init(byTitle: [String: CompsLookup?]) { self.byTitle = byTitle }
    func lookup(title: String, brand: String?, size: String?) async throws -> CompsLookup? {
        byTitle[title] ?? nil
    }
}
