import SwiftUI

/// View-model for the paywall. Loads StoreKit prices + the user's current
/// billing state, gates purchasing (block subscriptions when an active Stripe
/// sub is managed on web), and drives purchases through `StoreKitProviding`. The
/// derived gating + `buy` flow are unit-tested with a fake service; `load`'s
/// Supabase fetch is impure and not unit-tested.
@MainActor
@Observable
final class PaywallStore {

    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    /// Snapshot of the user's billing state, fetched after load/purchase.
    struct BillingSnapshot: Equatable {
        var plan: String
        var status: String?
        var source: String?
        var credits: Int
        /// Current period end (renewal/expiry) from the server `users` row.
        var periodEnd: Date? = nil
        /// True when the subscription is set to NOT auto-renew at period end.
        var cancelAtPeriodEnd: Bool? = nil

        /// Parse a Postgres `timestamptz` string (with or without fractional
        /// seconds) into a `Date`.
        static func parseISODate(_ string: String) -> Date? {
            let withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withFraction.date(from: string) { return date }
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            return plain.date(from: string)
        }
    }

    private let service: StoreKitProviding
    private let billingFetcher: () async -> BillingSnapshot?
    private let catalogLoader: () async -> [CatalogProduct]
    let userId: UUID

    var phase: Phase = .loading
    var prices: [String: String] = [:]
    /// Reference display prices from the canonical server catalog (US-808),
    /// keyed by product id. Used when StoreKit prices haven't loaded; the
    /// hardcoded `IAPCatalog` entry remains the last-resort offline fallback.
    var catalogFallback: [String: String] = [:]
    /// Selected subscription billing interval for display ("monthly"/"yearly").
    var interval: String = "monthly"

    // Current billing state (server truth, enriched by StoreKit for App Store subs).
    var currentPlan: String = "free"
    /// The EXACT active subscription product id (e.g. `…sub.pro.yearly`), from the
    /// on-device StoreKit entitlement. Lets the paywall gate only the current
    /// product rather than the whole tier, so a monthly subscriber can cross-grade
    /// to the yearly of the SAME tier (previously both intervals rendered as
    /// "Current" and were un-tappable). nil for free / web-billed users.
    var currentProductId: String?
    var billingSource: String?
    /// True only once a billing snapshot was successfully fetched from the server.
    /// A network/RLS failure leaves this false so the subscription gate fails
    /// CLOSED: a Stripe (web) subscriber whose billing fetch fails would otherwise
    /// see enabled App Store subscribe buttons (`billingSource` stays nil →
    /// `managedOnWeb` false) and could start a SECOND, Apple-billed subscription
    /// on top of their web one. A legitimately-free user still fetches a non-nil
    /// snapshot (source nil), so this never blocks them.
    var billingLoaded = false
    var subscriptionStatus: String?
    var creditBalance: Int = 0
    /// Renewal/expiry date of the active subscription, for the management card.
    var subscriptionRenewalDate: Date?
    /// Whether the active subscription will auto-renew at period end.
    var autoRenewEnabled: Bool = true

    // Purchase flow.
    var purchasingId: String?
    var purchaseError: String?
    var purchaseSucceeded = false
    /// Set when a purchase verified locally but the edge rejected the App Store
    /// switch because an active Stripe (web) subscription owns the plan — the UI
    /// presents the "manage on web" route instead of a bare error.
    var stripeConflict = false
    /// Set when a purchase is deferred for approval (Ask to Buy / SCA). The buy
    /// returns without an entitlement; the transaction listener grants it once
    /// approved, so the UI tells the user it's pending rather than dismissing
    /// silently (US-1144).
    var purchasePending = false
    /// Set when a purchase verified locally + charged, but the edge couldn't be
    /// reached to grant it after retries (`.pendingServerConfirmation`). The
    /// transaction is left unfinished and the listener/ASSN reconcile it, so the
    /// UI reassures the user it'll appear shortly instead of claiming instant
    /// success (the old bug fired a success haptic on an unrecorded purchase).
    var purchaseProcessing = false

    /// Outcome of the most recent Restore Purchases tap (US-1251). Previously
    /// restore was fire-and-forget, so a successful restore, a "nothing here",
    /// and a hard failure all looked identical (the screen just did nothing).
    enum RestoreResult: Equatable {
        /// `AppStore.sync()` succeeded and re-linked an active subscription.
        case restored
        /// `AppStore.sync()` succeeded but there was nothing to restore.
        case nothingToRestore
        /// `AppStore.sync()` failed; the message is shown to the user.
        case failed(String)
    }

    /// The last restore outcome, surfaced by the UI as an alert. `nil` once shown
    /// (the binding clears it) or when restore was quietly cancelled by the user.
    var restoreResult: RestoreResult?
    /// True while a restore is in flight (drives the button's spinner).
    var restoring = false

    /// User-facing copy for the current ``restoreResult`` (`nil` when none/cancelled).
    var restoreResultMessage: String? {
        switch restoreResult {
        case .restored:
            return "Your purchases were restored."
        case .nothingToRestore:
            return "There were no purchases to restore on this Apple ID."
        case .failed:
            return "We couldn't restore your purchases. Check your connection and try again."
        case nil:
            return nil
        }
    }

    /// Observes ``StoreKitService/entitlementsDidChangeNotification`` so an
    /// out-of-band renewal/refund/revoke (delivered to the transaction listener)
    /// re-fetches billing state and clears stale paid features.
    ///
    /// `nonisolated(unsafe)` so the nonisolated `deinit` can cancel it: `Task` is
    /// `Sendable` and `cancel()` is safe from any context, the property is only
    /// mutated on the main actor (in `init`), and `deinit` reads it exactly once
    /// at dealloc — there's no actual race to guard against.
    nonisolated(unsafe) private var entitlementObserver: Task<Void, Never>?

    /// US-1253: coalesces back-to-back entitlement-change notifications. StoreKit
    /// can deliver several `Transaction.updates` in a burst (a renewal + the
    /// matching revoke of the prior product, a restore replaying every
    /// transaction), which would otherwise fire one billing re-fetch per
    /// notification. A debounce window collapses a storm into a single refresh.
    ///
    /// `nonisolated(unsafe)` for the same reason as ``entitlementObserver``: only
    /// mutated on the main actor, and `deinit` cancels it exactly once.
    nonisolated(unsafe) private var entitlementRefreshTask: Task<Void, Never>?
    private let entitlementRefreshDebounce: Duration

    init(
        userId: UUID,
        service: StoreKitProviding = StoreKitService(),
        billingFetcher: @escaping () async -> BillingSnapshot? = PaywallStore.liveBillingFetcher,
        catalogLoader: @escaping () async -> [CatalogProduct] = PaywallStore.liveCatalogLoader,
        entitlementRefreshDebounce: Duration = .milliseconds(400)
    ) {
        self.userId = userId
        self.service = service
        self.billingFetcher = billingFetcher
        self.catalogLoader = catalogLoader
        self.entitlementRefreshDebounce = entitlementRefreshDebounce
        entitlementObserver = Task { [weak self] in
            let stream = NotificationCenter.default.notifications(
                named: StoreKitService.entitlementsDidChangeNotification)
            for await _ in stream {
                self?.scheduleEntitlementRefresh()
            }
        }
    }

    deinit {
        entitlementObserver?.cancel()
        entitlementRefreshTask?.cancel()
    }

    /// Restarts the debounce timer on every entitlement-change notification, so
    /// only the last notification in a burst actually drives a billing re-fetch.
    private func scheduleEntitlementRefresh() {
        entitlementRefreshTask?.cancel()
        let debounce = entitlementRefreshDebounce
        entitlementRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            await self?.refreshBilling()
        }
    }

    // MARK: - Derived (pure, tested)

    private static let entitlingStatuses: Set<String> = ["active", "trialing", "past_due"]

    /// True when an active Stripe subscription owns the plan — App Store
    /// subscription purchases are blocked (managed on the web instead).
    var managedOnWeb: Bool {
        billingSource == "stripe" && Self.entitlingStatuses.contains(subscriptionStatus ?? "")
    }

    /// True when an active App Store subscription owns the plan — managed
    /// natively (renewal/cancel via the system sheet, upgrade/downgrade by
    /// purchasing another product in the group). Drives the management card.
    var managedOnAppStore: Bool {
        billingSource == "appstore" && Self.entitlingStatuses.contains(subscriptionStatus ?? "")
    }

    func isCurrentPlan(_ plan: String) -> Bool {
        currentPlan.lowercased() == plan.lowercased()
    }

    /// True when StoreKit resolved a real, purchasable product/price for this
    /// entry. When false the product is NOT purchasable — `Product.products(for:)`
    /// returned nothing for its id (StoreKit offline, sandbox/App Store Connect
    /// misconfig, or — the likely review case — the subscription group not
    /// attached to the reviewed version while the consumables are). Tapping such
    /// a row dead-ends in `StoreKitService.purchase`'s `guard products.first`
    /// with "this item is unavailable" — the exact App Store 2.1(b) reject
    /// pattern. The display price still falls back to the catalog for context;
    /// the buy affordance must be suppressed (see `PaywallView.trailing`).
    func hasResolvedPrice(_ entry: IAPCatalogEntry) -> Bool {
        prices[entry.productId] != nil
    }

    func canPurchase(_ entry: IAPCatalogEntry) -> Bool {
        guard purchasingId == nil else { return false }
        // A product StoreKit couldn't resolve can't be bought — gate it here
        // (defense-in-depth behind the view's "Unavailable" label) so a
        // partially-loaded catalog never offers a tappable, fallback-priced row
        // that dead-ends on tap (App Store 2.1(b)).
        guard hasResolvedPrice(entry) else { return false }
        switch entry.kind {
        case .subscription:
            // Fail CLOSED when billing state couldn't be fetched (see
            // `billingLoaded`): never offer a subscription buy while we can't rule
            // out an active Stripe (web) subscription, which a second App Store sub
            // would double-bill on top of. Block only the EXACT current product —
            // NOT the whole tier — so a monthly subscriber can still cross-grade to
            // the yearly of the same tier (and vice versa).
            return billingLoaded && !managedOnWeb && entry.productId != currentProductId
        case .consumable:
            // Consumable credit packs don't conflict with a web subscription, so
            // they stay purchasable even if the billing snapshot is unavailable.
            return true
        }
    }

    func price(for entry: IAPCatalogEntry) -> String {
        // StoreKit (real, localized) → server catalog reference → hardcoded fallback.
        prices[entry.productId] ?? catalogFallback[entry.productId] ?? entry.fallbackPrice
    }

    // MARK: - Load

    func load() async {
        phase = .loading
        // Refresh the canonical reference prices before StoreKit so the paywall
        // never falls back to stale hardcoded prices when StoreKit is slow/offline.
        let catalog = await catalogLoader()
        if !catalog.isEmpty {
            catalogFallback = Dictionary(
                uniqueKeysWithValues: catalog.map { ($0.productId, $0.referencePriceDisplay) })
        }
        // US-1251: a thrown price-load error (network/StoreKit) is RETRYABLE and
        // must not be confused with a successfully-returned empty product list
        // (App Store Connect misconfig). Each gets its own messaging below.
        switch await service.loadPrices(ids: IAPCatalog.allIds) {
        case .failed:
            Telemetry.backgroundBreadcrumb(
                "Paywall: StoreKit price load threw — IAP temporarily unreachable",
                category: "iap")
            phase = .failed(Self.priceLoadRetryMessage)
            return
        case .loaded(let map):
            prices = map
        }
        await refreshBilling()
        // App Store 2.1(b): when StoreKit resolves NO products for any id, the
        // IAP layer is unavailable. Unlike a thrown error, an empty-but-successful
        // list is a config error (products not attached / approved) — surface a
        // recoverable "temporarily unavailable" failure with a retry instead of
        // rendering a paywall of fallback-priced rows that dead-end on "this item
        // is unavailable" when tapped. A partial result (some products resolved)
        // still renders — gaps fall back to the server catalog / hardcoded prices.
        if prices.isEmpty {
            Telemetry.backgroundBreadcrumb(
                "Paywall: StoreKit returned 0 of \(IAPCatalog.allIds.count) products — IAP unavailable",
                category: "iap")
            phase = .failed(Self.priceLoadConfigMessage)
            return
        }
        phase = .ready
    }

    /// Shown when price load THREW — a transient connection/StoreKit hiccup the
    /// user can resolve by retrying.
    static let priceLoadRetryMessage =
        "We couldn't reach the App Store to load plans. Check your connection and try again."
    /// Shown when price load SUCCEEDED but returned no products — a server/config
    /// problem the user can't fix by reconnecting, only wait out.
    static let priceLoadConfigMessage =
        "Plans aren't available right now. This is usually temporary — please try again shortly."

    // MARK: - Purchase

    @discardableResult
    func buy(_ entry: IAPCatalogEntry) async -> Bool {
        guard canPurchase(entry) else { return false }
        purchasingId = entry.productId
        purchaseError = nil
        stripeConflict = false
        purchasePending = false
        purchaseProcessing = false
        defer { purchasingId = nil }

        let outcome = await service.purchase(productId: entry.productId, appAccountToken: userId)
        switch outcome {
        case .success:
            purchaseSucceeded = true
            await refreshBilling()
            // US-1405: the edge `/appstore/verify` may not have committed the plan
            // switch by the time `refreshBilling()` reads the `users` row (it
            // self-heals via App Store Server Notifications). For a subscription,
            // optimistically reflect the just-purchased tier so the paywall shows
            // it as "Current" immediately instead of still offering its buy button
            // (inviting a confused re-purchase). The next refresh reconciles to
            // server truth. Consumables don't change the plan — credit balance is
            // already refreshed above.
            if case let .subscription(plan, _) = entry.kind {
                currentPlan = plan
                currentProductId = entry.productId
                billingSource = "appstore"
                if !Self.entitlingStatuses.contains(subscriptionStatus ?? "") {
                    subscriptionStatus = "active"
                }
            }
            return true
        case .pending:
            // Ask to Buy / SCA: no entitlement yet — the listener grants it on
            // approval. Tell the user instead of dismissing silently (US-1144).
            purchasePending = true
            return false
        case .userCancelled:
            return false
        case .stripeConflict:
            // Local purchase verified, but the server won't switch billing while
            // a web (Stripe) subscription is active — route the user to web billing.
            stripeConflict = true
            return false
        case .pendingServerConfirmation:
            // Charged + locally verified, but the server grant didn't confirm yet.
            // The transaction is left unfinished for the listener/ASSN to reconcile,
            // so refresh (in case it already landed) and reassure — don't claim
            // success on a purchase the server has no record of yet.
            await refreshBilling()
            purchaseProcessing = true
            return false
        case .verificationFailed:
            purchaseError = "Your purchase couldn't be verified. If you were charged, it'll apply shortly."
            return false
        case let .failed(message):
            purchaseError = message
            return false
        }
    }

    func restore() async {
        guard !restoring else { return }
        restoring = true
        restoreResult = nil
        defer { restoring = false }

        switch await service.restore() {
        case .cancelled:
            // The user dismissed the App Store sign-in sheet — stay quiet.
            return
        case .failed(let message):
            Telemetry.backgroundBreadcrumb(
                "Paywall restore failed: \(message)", category: "iap")
            restoreResult = .failed(message)
        case .synced:
            await refreshBilling()
            // The sync succeeded; whether anything was actually restored depends
            // on the on-device entitlement (consumables aren't restorable, so an
            // active auto-renewable subscription is the signal). Tell the user
            // which happened rather than leaving them guessing.
            let hasSubscription = await service.currentSubscription() != nil
            restoreResult = hasSubscription ? .restored : .nothingToRestore
        }
    }

    /// Re-fetch billing state after an out-of-band change (e.g. returning from
    /// the native manage-subscriptions sheet, where the user may have toggled
    /// auto-renew or cancelled).
    func refreshBillingState() async {
        await refreshBilling()
    }

    // MARK: - Helpers (impure; not unit-tested)

    private func refreshBilling() async {
        if let snapshot = await billingFetcher() {
            currentPlan = snapshot.plan
            subscriptionStatus = snapshot.status
            billingSource = snapshot.source
            creditBalance = snapshot.credits
            subscriptionRenewalDate = snapshot.periodEnd
            autoRenewEnabled = !(snapshot.cancelAtPeriodEnd ?? false)
            billingLoaded = true
        }
        // Else keep prior values; the paywall still renders with defaults, but
        // `billingLoaded` stays false so `canPurchase` blocks subscription buys
        // until we can confirm the user isn't already Stripe-subscribed.

        // Enrich from StoreKit's on-device entitlement — the freshest source for
        // App Store-billed subs (the server snapshot lags the webhook). Stripe
        // users have no StoreKit entitlement (nil) → keep the server values.
        if let entitlement = await service.currentSubscription() {
            subscriptionRenewalDate = entitlement.renewalDate ?? subscriptionRenewalDate
            autoRenewEnabled = entitlement.willAutoRenew
            currentProductId = entitlement.productId
        }
    }

    /// Live billing fetch from Supabase (RLS-scoped to the caller). Impure;
    /// injected so tests can stub it.
    static let liveBillingFetcher: () async -> BillingSnapshot? = {
        struct Row: Decodable {
            let flipdesk_plan: String?
            let subscription_status: String?
            let billing_source: String?
            let grade_credit_balance: Int?
            let flipdesk_period_end: String?
            let flipdesk_cancel_at_period_end: Bool?
        }
        do {
            let rows: [Row] = try await SupabaseShared.client
                .from("users")
                .select(
                    "flipdesk_plan, subscription_status, billing_source, grade_credit_balance, flipdesk_period_end, flipdesk_cancel_at_period_end")
                .limit(1)
                .execute()
                .value
            guard let row = rows.first else { return nil }
            return BillingSnapshot(
                plan: row.flipdesk_plan ?? "free",
                status: row.subscription_status,
                source: row.billing_source,
                credits: row.grade_credit_balance ?? 0,
                periodEnd: row.flipdesk_period_end.flatMap(BillingSnapshot.parseISODate),
                cancelAtPeriodEnd: row.flipdesk_cancel_at_period_end)
        } catch {
            return nil
        }
    }

    /// Live canonical-catalog fetch (server source of truth, US-808). Impure;
    /// injected so tests can stub it.
    static let liveCatalogLoader: () async -> [CatalogProduct] = {
        await CatalogService().loadCatalog()
    }
}
