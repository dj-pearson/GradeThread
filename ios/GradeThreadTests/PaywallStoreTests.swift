import XCTest
@testable import GradeThread

/// `PaywallStore` gating + purchase flow (in-memory service + stubbed billing).
@MainActor
final class PaywallStoreTests: XCTestCase {

    private let uid = UUID()

    private func store(
        service: FakeStoreKit = FakeStoreKit(),
        billing: PaywallStore.BillingSnapshot? = nil,
        catalog: [CatalogProduct] = []
    ) -> PaywallStore {
        PaywallStore(
            userId: uid, service: service,
            billingFetcher: { billing }, catalogLoader: { catalog })
    }

    private func sub(_ id: String) -> IAPCatalogEntry { IAPCatalog.entry(for: id)! }
    private func pack(_ id: String) -> IAPCatalogEntry { IAPCatalog.entry(for: id)! }

    func test_managedOnWeb_onlyWhenStripeAndEntitling() {
        let s = store()
        s.billingSource = "stripe"; s.subscriptionStatus = "active"
        XCTAssertTrue(s.managedOnWeb)

        s.subscriptionStatus = "canceled"
        XCTAssertFalse(s.managedOnWeb)

        s.billingSource = "appstore"; s.subscriptionStatus = "active"
        XCTAssertFalse(s.managedOnWeb)
    }

    func test_canPurchase_subscriptionGating() {
        let s = store()
        // Free user, no Stripe → can buy Pro.
        XCTAssertTrue(s.canPurchase(sub("com.gradethread.sub.pro.monthly")))

        // Already on Pro → can't re-buy Pro.
        s.currentPlan = "pro"
        XCTAssertFalse(s.canPurchase(sub("com.gradethread.sub.pro.monthly")))
        // ...but can still move to Business.
        XCTAssertTrue(s.canPurchase(sub("com.gradethread.sub.business.monthly")))

        // Managed on web → all subscription purchases blocked.
        s.currentPlan = "free"; s.billingSource = "stripe"; s.subscriptionStatus = "active"
        XCTAssertFalse(s.canPurchase(sub("com.gradethread.sub.pro.monthly")))
    }

    func test_canPurchase_consumablesAlwaysAllowed() {
        let s = store()
        s.billingSource = "stripe"; s.subscriptionStatus = "active" // managed on web
        XCTAssertTrue(s.canPurchase(pack("com.gradethread.credits.25")))
    }

    func test_canPurchase_blockedWhilePurchasing() {
        let s = store()
        s.purchasingId = "com.gradethread.sub.pro.monthly"
        XCTAssertFalse(s.canPurchase(sub("com.gradethread.sub.pro.monthly")))
        XCTAssertFalse(s.canPurchase(pack("com.gradethread.credits.25")))
    }

    func test_price_fallsBackWhenUnpriced() {
        let s = store()
        XCTAssertEqual(s.price(for: sub("com.gradethread.sub.pro.monthly")), "$59/mo")
        s.prices = ["com.gradethread.sub.pro.monthly": "£55.00"]
        XCTAssertEqual(s.price(for: sub("com.gradethread.sub.pro.monthly")), "£55.00")
    }

    func test_load_usesServerCatalogReferencePriceOverHardcodedFallback() async {
        let entry = CatalogProduct(
            productId: "com.gradethread.sub.pro.monthly", kind: "subscription",
            plan: "pro", interval: "monthly", credits: nil,
            title: "Pro", blurb: "", referencePriceCents: 6900,
            referencePriceDisplay: "$69/mo")
        let s = store(catalog: [entry])
        await s.load()
        // StoreKit gave no price, so the server catalog reference price wins over
        // the hardcoded IAPProduct fallback ("$59/mo").
        XCTAssertEqual(s.price(for: sub("com.gradethread.sub.pro.monthly")), "$69/mo")
    }

    func test_load_emptyCatalogKeepsHardcodedFallback() async {
        let s = store(catalog: [])
        await s.load()
        XCTAssertEqual(s.price(for: sub("com.gradethread.sub.pro.monthly")), "$59/mo")
    }

    func test_buy_success_refreshesBilling() async {
        let fake = FakeStoreKit(); fake.outcome = .success
        let s = store(service: fake, billing: .init(plan: "pro", status: "active", source: "appstore", credits: 0))
        let ok = await s.buy(sub("com.gradethread.sub.pro.monthly"))
        XCTAssertTrue(ok)
        XCTAssertTrue(s.purchaseSucceeded)
        XCTAssertEqual(fake.purchasedProductId, "com.gradethread.sub.pro.monthly")
        XCTAssertEqual(fake.purchasedToken, uid)
        XCTAssertEqual(s.currentPlan, "pro")        // refreshed
        XCTAssertNil(s.purchasingId)                // cleared
    }

    func test_buy_failure_surfacesError() async {
        let fake = FakeStoreKit(); fake.outcome = .failed("Card declined")
        let s = store(service: fake)
        let ok = await s.buy(sub("com.gradethread.sub.pro.monthly"))
        XCTAssertFalse(ok)
        XCTAssertEqual(s.purchaseError, "Card declined")
        XCTAssertFalse(s.purchaseSucceeded)
    }

    func test_buy_cancelled_isQuiet() async {
        let fake = FakeStoreKit(); fake.outcome = .userCancelled
        let s = store(service: fake)
        let ok = await s.buy(sub("com.gradethread.sub.pro.monthly"))
        XCTAssertFalse(ok)
        XCTAssertNil(s.purchaseError)
    }

    // MARK: - Disclosures (Guideline 3.1.2)

    func test_subscriptionDisclosure_statesAutoRenewCadence() {
        XCTAssertTrue(sub("com.gradethread.sub.pro.monthly").isSubscription)
        XCTAssertEqual(
            sub("com.gradethread.sub.pro.monthly").renewalDisclosure,
            "Auto-renews every month")
        XCTAssertEqual(
            sub("com.gradethread.sub.pro.yearly").renewalDisclosure,
            "Auto-renews every year")
        XCTAssertEqual(sub("com.gradethread.sub.pro.monthly").kind.billingPeriodNoun, "month")
        XCTAssertEqual(sub("com.gradethread.sub.pro.yearly").kind.billingPeriodNoun, "year")
    }

    func test_consumableDisclosure_isOneTimeNotAutoRenewing() {
        let credits = pack("com.gradethread.credits.25")
        XCTAssertFalse(credits.isSubscription)
        XCTAssertNil(credits.kind.billingPeriodNoun)
        XCTAssertEqual(credits.renewalDisclosure, "One-time purchase · credits never expire")
    }

    func test_buy_blockedPurchaseDoesNotCallService() async {
        let fake = FakeStoreKit(); fake.outcome = .success
        let s = store(service: fake)
        s.currentPlan = "pro" // can't re-buy Pro
        let ok = await s.buy(sub("com.gradethread.sub.pro.monthly"))
        XCTAssertFalse(ok)
        XCTAssertNil(fake.purchasedProductId)
    }
}

private final class FakeStoreKit: StoreKitProviding {
    var outcome: PurchaseOutcome = .success
    var prices: [String: String] = [:]
    private(set) var purchasedProductId: String?
    private(set) var purchasedToken: UUID?
    private(set) var restored = false

    func loadPrices(ids: [String]) async -> [String: String] { prices }

    func purchase(productId: String, appAccountToken: UUID) async -> PurchaseOutcome {
        purchasedProductId = productId
        purchasedToken = appAccountToken
        return outcome
    }

    func restore() async { restored = true }
}
