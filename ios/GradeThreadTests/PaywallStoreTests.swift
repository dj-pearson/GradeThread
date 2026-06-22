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
        let s = PaywallStore(
            userId: uid, service: service,
            billingFetcher: { billing }, catalogLoader: { catalog })
        // Default to a fully-loaded StoreKit catalog (every product priced), the
        // common case. Tests exercising an unresolved/partial catalog override
        // `s.prices` directly or drive it through `load()` (which replaces it).
        s.prices = Dictionary(uniqueKeysWithValues: IAPCatalog.allIds.map { ($0, "$0.00") })
        return s
    }

    private func sub(_ id: String) -> IAPCatalogEntry { IAPCatalog.entry(for: id)! }
    private func pack(_ id: String) -> IAPCatalogEntry { IAPCatalog.entry(for: id)! }

    // US-1154: the entitlement-change observer (US-1144) captures [weak self]
    // and is cancelled in deinit; verify it introduces no retain cycle.
    func test_paywallStore_noRetainCycle() {
        weak var weak: PaywallStore?
        autoreleasepool {
            let s = store()
            weak = s
        }
        XCTAssertNil(weak, "PaywallStore leaked — the entitlement observer likely retains self")
    }

    func test_managedOnWeb_onlyWhenStripeAndEntitling() {
        let s = store()
        s.billingSource = "stripe"; s.subscriptionStatus = "active"
        XCTAssertTrue(s.managedOnWeb)
        XCTAssertFalse(s.managedOnAppStore)

        s.subscriptionStatus = "canceled"
        XCTAssertFalse(s.managedOnWeb)

        s.billingSource = "appstore"; s.subscriptionStatus = "active"
        XCTAssertFalse(s.managedOnWeb)
    }

    func test_managedOnAppStore_onlyWhenAppstoreAndEntitling() {
        let s = store()
        s.billingSource = "appstore"; s.subscriptionStatus = "active"
        XCTAssertTrue(s.managedOnAppStore)
        XCTAssertFalse(s.managedOnWeb)

        s.subscriptionStatus = "trialing"
        XCTAssertTrue(s.managedOnAppStore)

        s.subscriptionStatus = "canceled"
        XCTAssertFalse(s.managedOnAppStore)

        // Stripe-billed never reads as App Store-managed.
        s.billingSource = "stripe"; s.subscriptionStatus = "active"
        XCTAssertFalse(s.managedOnAppStore)
    }

    func test_canPurchase_subscriptionGating() {
        let s = store()
        // StoreKit resolved real prices for these products (loaded paywall).
        s.prices = [
            "com.gradethread.sub.pro.monthly": "$59.00",
            "com.gradethread.sub.business.monthly": "$99.00",
        ]
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
        s.prices = ["com.gradethread.credits.25": "$24.99"] // StoreKit resolved it
        s.billingSource = "stripe"; s.subscriptionStatus = "active" // managed on web
        XCTAssertTrue(s.canPurchase(pack("com.gradethread.credits.25")))
    }

    // App Store 2.1(b): a product StoreKit couldn't resolve (e.g. the
    // subscription group not attached to the reviewed version while the
    // consumables are) must NOT be purchasable — otherwise its row renders a
    // tappable fallback price that dead-ends on "this item is unavailable."
    func test_canPurchase_falseWhenStoreKitPriceUnresolved() {
        let s = store()
        // Consumable priced, subscription NOT (partial catalog load).
        s.prices = ["com.gradethread.credits.25": "$24.99"]
        XCTAssertTrue(s.hasResolvedPrice(pack("com.gradethread.credits.25")))
        XCTAssertTrue(s.canPurchase(pack("com.gradethread.credits.25")))

        XCTAssertFalse(s.hasResolvedPrice(sub("com.gradethread.sub.pro.monthly")))
        XCTAssertFalse(s.canPurchase(sub("com.gradethread.sub.pro.monthly")))
    }

    func test_canPurchase_blockedWhilePurchasing() {
        let s = store()
        s.purchasingId = "com.gradethread.sub.pro.monthly"
        XCTAssertFalse(s.canPurchase(sub("com.gradethread.sub.pro.monthly")))
        XCTAssertFalse(s.canPurchase(pack("com.gradethread.credits.25")))
    }

    func test_price_fallsBackWhenUnpriced() {
        let s = store()
        s.prices = [:] // StoreKit hasn't resolved anything yet
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
        // StoreKit resolved at least one product (so the paywall is ready) but not
        // pro.monthly — the server catalog reference price wins over the hardcoded
        // IAPProduct fallback ("$59/mo") for the gap.
        let fake = FakeStoreKit(); fake.prices = ["com.gradethread.credits.10": "$24.99"]
        let s = store(service: fake, catalog: [entry])
        await s.load()
        XCTAssertEqual(s.phase, .ready)
        XCTAssertEqual(s.price(for: sub("com.gradethread.sub.pro.monthly")), "$69/mo")
    }

    func test_load_emptyCatalogKeepsHardcodedFallback() async {
        let fake = FakeStoreKit(); fake.prices = ["com.gradethread.credits.10": "$24.99"]
        let s = store(service: fake, catalog: [])
        await s.load()
        XCTAssertEqual(s.phase, .ready)
        XCTAssertEqual(s.price(for: sub("com.gradethread.sub.pro.monthly")), "$59/mo")
    }

    // App Store 2.1(b): when StoreKit resolves NO products for any id, the paywall
    // must show a recoverable failure (retry) rather than landing on `.ready` with
    // fallback-priced rows that dead-end with "this item is unavailable" on tap.
    func test_load_noStoreKitProducts_failsRecoverablyInsteadOfReady() async {
        let fake = FakeStoreKit() // prices = [:] — StoreKit knows nothing
        let s = store(service: fake, catalog: [])
        await s.load()
        guard case .failed = s.phase else {
            return XCTFail("Expected .failed when StoreKit returns no products, got \(s.phase)")
        }
    }

    // A partial StoreKit result (some products resolved) is still a usable paywall.
    func test_load_partialStoreKitProducts_isReady() async {
        let fake = FakeStoreKit(); fake.prices = ["com.gradethread.sub.pro.monthly": "$59.00"]
        let s = store(service: fake, catalog: [])
        await s.load()
        XCTAssertEqual(s.phase, .ready)
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

    func test_buy_stripeConflict_routesToWebInsteadOfBareError() async {
        let fake = FakeStoreKit(); fake.outcome = .stripeConflict
        let s = store(service: fake)
        let ok = await s.buy(sub("com.gradethread.sub.pro.monthly"))
        XCTAssertFalse(ok)
        XCTAssertTrue(s.stripeConflict)           // UI presents the web-billing route
        XCTAssertNil(s.purchaseError)             // not a bare error
        XCTAssertFalse(s.purchaseSucceeded)
    }

    func test_buy_pending_setsPendingStateNotError() async {
        let fake = FakeStoreKit(); fake.outcome = .pending
        let s = store(service: fake)
        let ok = await s.buy(sub("com.gradethread.sub.pro.monthly"))
        XCTAssertFalse(ok)
        XCTAssertTrue(s.purchasePending)          // UI shows "pending approval"
        XCTAssertFalse(s.purchaseSucceeded)
        XCTAssertNil(s.purchaseError)             // not a failure
        XCTAssertNil(s.purchasingId)              // spinner cleared
    }

    func test_buy_clearsStripeConflictAtStart() async {
        let fake = FakeStoreKit(); fake.outcome = .success
        let s = store(service: fake, billing: .init(plan: "pro", status: "active", source: "appstore", credits: 0))
        s.stripeConflict = true                   // stale from a prior attempt
        _ = await s.buy(sub("com.gradethread.sub.pro.monthly"))
        XCTAssertFalse(s.stripeConflict)
    }

    func test_load_populatesRenewalAndAutoRenewFromSnapshot() async {
        let renewal = Date(timeIntervalSince1970: 1_750_000_000)
        let s = store(billing: .init(
            plan: "pro", status: "active", source: "appstore", credits: 0,
            periodEnd: renewal, cancelAtPeriodEnd: false))
        await s.load()
        XCTAssertEqual(s.subscriptionRenewalDate, renewal)
        XCTAssertTrue(s.autoRenewEnabled)
    }

    func test_load_cancelAtPeriodEnd_marksAutoRenewOff() async {
        let s = store(billing: .init(
            plan: "pro", status: "active", source: "appstore", credits: 0,
            periodEnd: nil, cancelAtPeriodEnd: true))
        await s.load()
        XCTAssertFalse(s.autoRenewEnabled)
    }

    func test_load_storeKitEntitlementOverridesServerSnapshot() async {
        let serverRenewal = Date(timeIntervalSince1970: 1_750_000_000)
        let kitRenewal = Date(timeIntervalSince1970: 1_760_000_000)
        let fake = FakeStoreKit()
        fake.entitlement = SubscriptionEntitlement(
            productId: "com.gradethread.sub.pro.monthly",
            renewalDate: kitRenewal, willAutoRenew: false)
        let s = store(service: fake, billing: .init(
            plan: "pro", status: "active", source: "appstore", credits: 0,
            periodEnd: serverRenewal, cancelAtPeriodEnd: false))
        await s.load()
        // StoreKit's on-device entitlement is the fresher source for App Store subs.
        XCTAssertEqual(s.subscriptionRenewalDate, kitRenewal)
        XCTAssertFalse(s.autoRenewEnabled)
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
    var entitlement: SubscriptionEntitlement?
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

    func currentSubscription() async -> SubscriptionEntitlement? { entitlement }
}
