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
    var billingSource: String?
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

    init(
        userId: UUID,
        service: StoreKitProviding = StoreKitService(),
        billingFetcher: @escaping () async -> BillingSnapshot? = PaywallStore.liveBillingFetcher,
        catalogLoader: @escaping () async -> [CatalogProduct] = PaywallStore.liveCatalogLoader
    ) {
        self.userId = userId
        self.service = service
        self.billingFetcher = billingFetcher
        self.catalogLoader = catalogLoader
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

    func canPurchase(_ entry: IAPCatalogEntry) -> Bool {
        guard purchasingId == nil else { return false }
        switch entry.kind {
        case let .subscription(plan, _):
            return !managedOnWeb && !isCurrentPlan(plan)
        case .consumable:
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
        prices = await service.loadPrices(ids: IAPCatalog.allIds)
        await refreshBilling()
        phase = .ready
    }

    // MARK: - Purchase

    @discardableResult
    func buy(_ entry: IAPCatalogEntry) async -> Bool {
        guard canPurchase(entry) else { return false }
        purchasingId = entry.productId
        purchaseError = nil
        stripeConflict = false
        defer { purchasingId = nil }

        let outcome = await service.purchase(productId: entry.productId, appAccountToken: userId)
        switch outcome {
        case .success:
            purchaseSucceeded = true
            await refreshBilling()
            return true
        case .userCancelled, .pending:
            return false
        case .stripeConflict:
            // Local purchase verified, but the server won't switch billing while
            // a web (Stripe) subscription is active — route the user to web billing.
            stripeConflict = true
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
        await service.restore()
        await refreshBilling()
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
        }
        // Else keep prior values; the paywall still renders with defaults.

        // Enrich from StoreKit's on-device entitlement — the freshest source for
        // App Store-billed subs (the server snapshot lags the webhook). Stripe
        // users have no StoreKit entitlement (nil) → keep the server values.
        if let entitlement = await service.currentSubscription() {
            subscriptionRenewalDate = entitlement.renewalDate ?? subscriptionRenewalDate
            autoRenewEnabled = entitlement.willAutoRenew
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
