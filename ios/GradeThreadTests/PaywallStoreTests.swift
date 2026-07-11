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
        // Billing snapshot fetched successfully (free user, no Stripe).
        s.billingLoaded = true
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

    // Fail CLOSED: when the billing snapshot couldn't be fetched (network/RLS
    // failure → `billingLoaded` false), a subscription buy is blocked even though
    // `billingSource` is nil — otherwise a Stripe (web) subscriber whose fetch
    // failed could start a second, Apple-billed subscription (double-billing).
    // Consumables stay purchasable (they don't conflict with a web sub).
    func test_canPurchase_failsClosedWhenBillingUnloaded() {
        let s = store()
        s.prices = [
            "com.gradethread.sub.pro.monthly": "$59.00",
            "com.gradethread.credits.25": "$24.99",
        ]
        // billingLoaded defaults false (fetch never succeeded).
        XCTAssertFalse(s.billingLoaded)
        XCTAssertFalse(s.canPurchase(sub("com.gradethread.sub.pro.monthly")))
        XCTAssertTrue(s.canPurchase(pack("com.gradethread.credits.25")))

        // Once billing loads, a free user can subscribe again.
        s.billingLoaded = true
        XCTAssertTrue(s.canPurchase(sub("com.gradethread.sub.pro.monthly")))
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

    // US-1405: the edge verify can lag the purchase, so the server `users` row
    // may still report "free" right after a successful subscription buy. The
    // paywall must optimistically reflect the purchased tier so it shows
    // "Current" immediately instead of re-offering the buy button.
    func test_buy_success_optimisticallyReflectsPurchasedPlan_whenServerLags() async {
        let fake = FakeStoreKit(); fake.outcome = .success
        // Server snapshot still lags on the old plan.
        let s = store(service: fake, billing: .init(plan: "free", status: nil, source: nil, credits: 0))
        let ok = await s.buy(sub("com.gradethread.sub.pro.monthly"))
        XCTAssertTrue(ok)
        XCTAssertEqual(s.currentPlan, "pro")          // optimistic, not the lagging "free"
        XCTAssertEqual(s.billingSource, "appstore")
        XCTAssertEqual(s.subscriptionStatus, "active")
        XCTAssertTrue(s.isCurrentPlan("pro"))         // row now renders as "Current"
    }

    // A consumable credit-pack purchase must NOT mutate the subscription plan.
    func test_buy_success_consumable_doesNotChangePlan() async {
        let fake = FakeStoreKit(); fake.outcome = .success
        let s = store(service: fake, billing: .init(plan: "free", status: nil, source: nil, credits: 0))
        _ = await s.buy(pack(IAPCatalog.all.first { !$0.isSubscription }!.productId))
        XCTAssertEqual(s.currentPlan, "free")         // unchanged by a credit pack
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

    // MARK: - Restore (US-1251)

    // A successful sync that re-links an active auto-renewable subscription
    // reports "restored" so the UI can confirm it (not silently no-op).
    func test_restore_syncedWithSubscription_reportsRestored() async {
        let fake = FakeStoreKit()
        fake.restoreOutcome = .synced
        fake.entitlement = SubscriptionEntitlement(
            productId: "com.gradethread.sub.pro.monthly",
            renewalDate: nil, willAutoRenew: true)
        let s = store(service: fake)
        await s.restore()
        XCTAssertTrue(fake.restored)
        XCTAssertEqual(s.restoreResult, .restored)
        XCTAssertFalse(s.restoring)                       // spinner cleared
        XCTAssertEqual(s.restoreResultMessage, "Your purchases were restored.")
    }

    // A successful sync with nothing on this Apple ID reports "nothing to
    // restore" rather than implying a restore happened.
    func test_restore_syncedWithoutEntitlement_reportsNothingToRestore() async {
        let fake = FakeStoreKit()
        fake.restoreOutcome = .synced
        fake.entitlement = nil
        let s = store(service: fake)
        await s.restore()
        XCTAssertEqual(s.restoreResult, .nothingToRestore)
        XCTAssertNotNil(s.restoreResultMessage)
    }

    // A failed AppStore.sync surfaces a failure result the UI shows as an alert,
    // instead of the old `try?`-swallowed silent no-op.
    func test_restore_failure_surfacesFailedResult() async {
        let fake = FakeStoreKit()
        fake.restoreOutcome = .failed("network down")
        let s = store(service: fake)
        await s.restore()
        guard case .failed = s.restoreResult else {
            return XCTFail("Expected .failed, got \(String(describing: s.restoreResult))")
        }
        XCTAssertFalse(s.restoring)
        XCTAssertNotNil(s.restoreResultMessage)
    }

    // The user dismissing the sign-in sheet is not an error — stay quiet (no alert).
    func test_restore_cancelled_isQuiet() async {
        let fake = FakeStoreKit()
        fake.restoreOutcome = .cancelled
        let s = store(service: fake)
        await s.restore()
        XCTAssertNil(s.restoreResult)
    }

    // Re-entrant taps while a restore is in flight are ignored (guard !restoring).
    func test_restore_ignoresReentrantCallWhileInFlight() async {
        let fake = FakeStoreKit()
        let s = store(service: fake)
        s.restoring = true                               // simulate in-flight restore
        await s.restore()
        XCTAssertFalse(fake.restored)                    // service not called again
    }

    // MARK: - Price load distinction (US-1251)

    // A THROWN price-load error (network/StoreKit) is retryable and gets the
    // retry message — distinct from the empty-list config message below.
    func test_load_priceLoadThrew_failsWithRetryMessage() async {
        let fake = FakeStoreKit()
        fake.priceResult = .failed("offline")
        let s = store(service: fake, catalog: [])
        await s.load()
        XCTAssertEqual(s.phase, .failed(PaywallStore.priceLoadRetryMessage))
    }

    // A successful-but-empty product list is a config error, not a transient
    // hiccup — it gets the config message, NOT the retry message.
    func test_load_emptyProducts_failsWithConfigMessage() async {
        let fake = FakeStoreKit()                         // prices empty → .loaded([:])
        let s = store(service: fake, catalog: [])
        await s.load()
        XCTAssertEqual(s.phase, .failed(PaywallStore.priceLoadConfigMessage))
        XCTAssertNotEqual(s.phase, .failed(PaywallStore.priceLoadRetryMessage))
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
    /// When set, overrides the `prices`-derived `.loaded` result so a test can
    /// simulate a THROWN price-load error (US-1251).
    var priceResult: PriceLoadResult?
    var restoreOutcome: RestoreOutcome = .synced
    var entitlement: SubscriptionEntitlement?
    private(set) var purchasedProductId: String?
    private(set) var purchasedToken: UUID?
    private(set) var restored = false

    func loadPrices(ids: [String]) async -> PriceLoadResult {
        priceResult ?? .loaded(prices)
    }

    func purchase(productId: String, appAccountToken: UUID) async -> PurchaseOutcome {
        purchasedProductId = productId
        purchasedToken = appAccountToken
        return outcome
    }

    func restore() async -> RestoreOutcome { restored = true; return restoreOutcome }

    func currentSubscription() async -> SubscriptionEntitlement? { entitlement }
}
