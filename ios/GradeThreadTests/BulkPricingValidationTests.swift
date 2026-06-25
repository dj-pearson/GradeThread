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
}
