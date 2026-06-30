import Foundation
import StoreKit

/// Outcome of a purchase attempt, with StoreKit types hidden so `PaywallStore`
/// (and its tests) stay StoreKit-free.
enum PurchaseOutcome: Equatable {
    case success
    case userCancelled
    case pending
    case verificationFailed
    case failed(String)
    /// The StoreKit purchase verified locally but the edge refused to switch
    /// billing to the App Store because an active Stripe (web) subscription
    /// owns the plan (409 ACTIVE_STRIPE_SUBSCRIPTION). The user must cancel the
    /// web subscription first — the UI routes them to web billing.
    case stripeConflict
}

/// Result of loading StoreKit display prices. Distinguishes a thrown error
/// (network/StoreKit hiccup — RETRYABLE) from a successfully-returned but
/// genuinely empty product list (App Store Connect misconfig — a config error),
/// so the paywall can show "retry" vs "temporarily unavailable" messaging
/// instead of collapsing both into one ambiguous empty map (US-1251).
enum PriceLoadResult: Equatable {
    /// `Product.products(for:)` returned — the map may be partial or empty.
    case loaded([String: String])
    /// The call threw (network/StoreKit). Retryable; the message is surfaced.
    case failed(String)
}

/// Outcome of restoring purchases. This boundary only reports whether
/// `AppStore.sync()` itself succeeded; `PaywallStore` decides "restored" vs
/// "nothing-to-restore" afterwards by re-checking entitlements (US-1251).
enum RestoreOutcome: Equatable {
    /// `AppStore.sync()` completed — the caller re-checks entitlements.
    case synced
    /// The user dismissed the sign-in sheet — stay quiet (no error to show).
    case cancelled
    /// `AppStore.sync()` threw. The message is surfaced so the UI can report it.
    case failed(String)
}

/// The user's current on-device auto-renewable subscription, derived from
/// `Transaction.currentEntitlements`. StoreKit types stay hidden so
/// `PaywallStore` (and its tests) remain StoreKit-free.
struct SubscriptionEntitlement: Equatable {
    let productId: String
    /// When the current period ends — a renewal date (auto-renew on) or an
    /// expiry date (auto-renew off).
    let renewalDate: Date?
    let willAutoRenew: Bool
}

/// The thin StoreKit boundary. Behind a protocol so `PaywallStore` is testable
/// with an in-memory fake. The concrete impl is IMPURE (StoreKit + network) and
/// is NOT unit-tested — the purchase handshake needs sandbox + a real device.
protocol StoreKitProviding {
    /// Load productId → localized display price (e.g. "$59.00"). The result
    /// distinguishes a thrown error from a (possibly empty) returned list so the
    /// paywall can tell a retryable hiccup from a config error (US-1251).
    func loadPrices(ids: [String]) async -> PriceLoadResult
    /// Buy a product; on a verified transaction, report it to the edge + finish it.
    func purchase(productId: String, appAccountToken: UUID) async -> PurchaseOutcome
    /// Restore purchases (`AppStore.sync()`); reports whether the sync succeeded.
    func restore() async -> RestoreOutcome
    /// The active auto-renewable subscription on this Apple ID, or nil if none.
    /// Used to surface renewal date + auto-renew state in the management card.
    func currentSubscription() async -> SubscriptionEntitlement?
}

/// `POST /api/payments/appstore/verify` response.
struct AppStoreVerifyResponse: Decodable {
    let plan: String
    let interval: String?
    let status: String
    let creditsBalance: Int
}

/// Thrown when a StoreKit product fetch exceeds ``StoreKitService/productFetchTimeout``
/// (US-1405). Conforms to `LocalizedError` so the purchase path surfaces an
/// actionable message instead of the generic "operation couldn't be completed."
struct StoreKitTimeoutError: LocalizedError {
    var errorDescription: String? {
        "The App Store is taking too long to respond. Please try again."
    }
}

struct StoreKitService: StoreKitProviding {
    private let api: EdgeAPI

    init(api: EdgeAPI = .shared) {
        self.api = api
    }

    /// US-1405: `Product.products(for:)` has NO built-in timeout. A wedged
    /// StoreKit daemon, an unreachable App Store, or a stuck sandbox sign-in can
    /// hang it indefinitely — leaving the paywall on an infinite spinner (the
    /// exact Guideline 2.1(b) reject pattern, since `PaywallStore.load()` awaits
    /// it before rendering). Bound it so a stall surfaces as a thrown error the
    /// paywall renders as a retryable `.failed` instead of spinning forever.
    static let productFetchTimeout: TimeInterval = 15

    /// `Product.products(for:)` raced against a hard timeout. Throws
    /// ``StoreKitTimeoutError`` if the fetch doesn't return within
    /// ``productFetchTimeout``.
    static func productsWithTimeout(for ids: [String]) async throws -> [Product] {
        try await withThrowingTaskGroup(of: [Product].self) { group in
            group.addTask { try await Product.products(for: ids) }
            group.addTask {
                try await Task.sleep(
                    nanoseconds: UInt64(productFetchTimeout * 1_000_000_000))
                throw StoreKitTimeoutError()
            }
            defer { group.cancelAll() }
            // Whichever finishes first wins; the loser is cancelled by `defer`.
            guard let result = try await group.next() else { throw StoreKitTimeoutError() }
            return result
        }
    }

    func loadPrices(ids: [String]) async -> PriceLoadResult {
        do {
            let products = try await Self.productsWithTimeout(for: ids)
            var map: [String: String] = [:]
            for product in products { map[product.id] = product.displayPrice }
            // A successful call with an empty map is a CONFIG error (products not
            // attached / approved), not a transient failure — report it as loaded
            // so the caller routes to "temporarily unavailable", not "retry".
            return .loaded(map)
        } catch {
            // A thrown error (network/StoreKit) is retryable — surface it so the
            // paywall shows a retry affordance rather than treating it as empty.
            Telemetry.backgroundBreadcrumb(
                "IAP price load threw: \(error.localizedDescription)", category: "iap")
            return .failed(error.localizedDescription)
        }
    }

    func purchase(productId: String, appAccountToken: UUID) async -> PurchaseOutcome {
        do {
            let products = try await Self.productsWithTimeout(for: [productId])
            guard let product = products.first else {
                return .failed("This item is unavailable right now.")
            }
            let result = try await product.purchase(options: [.appAccountToken(appAccountToken)])
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    // US-1405: report with bounded retry and only finish once the
                    // server has the transaction. A consumable (credit pack) is
                    // NEVER redelivered by `Transaction.updates` after `finish()`,
                    // so finishing an unreported consumable means the user paid but
                    // never got credits. On a transient report failure leave it
                    // unfinished — the launch transaction listener retries it (and
                    // App Store Server Notifications back-stop it).
                    let report = await reportWithRetry(jws: verification.jwsRepresentation)
                    if report != .failed {
                        await transaction.finish()
                    } else {
                        Telemetry.backgroundBreadcrumb(
                            "IAP foreground purchase: server report failed; leaving "
                                + "transaction unfinished for listener retry (product \(productId))",
                            category: "iap")
                    }
                    return report == .stripeConflict ? .stripeConflict : .success
                case .unverified:
                    Telemetry.backgroundBreadcrumb(
                        "IAP purchase failed local verification (product \(productId))",
                        category: "iap")
                    return .verificationFailed
                }
            case .userCancelled:
                return .userCancelled
            case .pending:
                return .pending
            @unknown default:
                return .failed("Unknown purchase result.")
            }
        } catch {
            // US-1148: a thrown purchase error (network, StoreKit) was previously
            // only surfaced to the UI; breadcrumb it for diagnosis too.
            Telemetry.backgroundBreadcrumb(
                "IAP purchase threw (product \(productId)): \(error.localizedDescription)",
                category: "iap")
            return .failed(error.localizedDescription)
        }
    }

    func restore() async -> RestoreOutcome {
        do {
            try await AppStore.sync()
            return .synced
        } catch StoreKitError.userCancelled {
            // The user dismissed the App Store sign-in sheet — not an error.
            return .cancelled
        } catch {
            // US-1251: previously `try?`-swallowed, so a failed restore looked
            // identical to a successful one. Surface it (+ breadcrumb) so the UI
            // can tell the user it didn't work instead of silently doing nothing.
            Telemetry.backgroundBreadcrumb(
                "IAP restore (AppStore.sync) failed: \(error.localizedDescription)",
                category: "iap")
            return .failed(error.localizedDescription)
        }
    }

    func currentSubscription() async -> SubscriptionEntitlement? {
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  transaction.productType == .autoRenewable,
                  // Defensive: `currentEntitlements` already excludes revoked
                  // (refunded) transactions, but never surface one as an active
                  // entitlement if StoreKit ever includes it (US-1144).
                  transaction.revocationDate == nil else { continue }
            // Auto-renew state lives on the renewal info, not the transaction.
            var willAutoRenew = true
            if let status = try? await transaction.subscriptionStatus,
               case .verified(let renewalInfo) = status.renewalInfo {
                willAutoRenew = renewalInfo.willAutoRenew
            }
            return SubscriptionEntitlement(
                productId: transaction.productID,
                renewalDate: transaction.expirationDate,
                willAutoRenew: willAutoRenew)
        }
        return nil
    }

    /// Result of reporting a signed transaction to the edge.
    private enum VerifyReport: Equatable { case ok, stripeConflict, failed }

    /// Send the signed transaction to the edge, which verifies + reconciles it
    /// into the user's plan/credits. Entitlement is also delivered server-side by
    /// App Store Server Notifications, so a transient failure here self-heals.
    /// A 409 ACTIVE_STRIPE_SUBSCRIPTION is surfaced so the caller can route the
    /// user to web billing instead of dead-ending on a generic error.
    private func reportToServer(jws: String) async -> VerifyReport {
        struct Body: Encodable { let jws: String }
        do {
            let _: AppStoreVerifyResponse = try await api.postJSON(
                "/api/payments/appstore/verify", body: Body(jws: jws))
            return .ok
        } catch let error as EdgeAPIError {
            if case .badRequest(let detail) = error, detail == "ACTIVE_STRIPE_SUBSCRIPTION" {
                return .stripeConflict
            }
            // US-1148: the edge rejected the verify (non-conflict). It self-heals
            // via App Store Server Notifications, but breadcrumb so a systemic
            // verify failure is visible rather than silently swallowed.
            Telemetry.backgroundBreadcrumb(
                "IAP server verify failed: \(error.localizedDescription)", category: "iap")
            return .failed
        } catch {
            Telemetry.backgroundBreadcrumb(
                "IAP server verify failed: \(error.localizedDescription)", category: "iap")
            return .failed
        }
    }

    /// Posted after the transaction listener processes a renewal, refund, or
    /// revocation so a live ``PaywallStore`` re-fetches billing state instead of
    /// showing stale paid-plan features until the next manual refresh (US-1144).
    static let entitlementsDidChangeNotification =
        Notification.Name("com.gradethread.app.entitlementsDidChange")

    /// How the listener should handle one transaction update. Factored out as a
    /// pure function so it's unit-testable without StoreKit types (US-1144).
    enum TransactionDisposition: Equatable {
        /// Verified, not revoked — report it and finish only once the server
        /// confirms (so a server outage re-queues it via next-launch redelivery).
        case grant
        /// Verified but revoked (refund/family revoke) — report the lapse and
        /// always finish so the revoked transaction clears.
        case revoke
        /// Failed JWS verification — never grant; leave unfinished for
        /// server-side reconciliation (App Store Server Notifications).
        case unverifiedDrop
    }

    static func disposition(isVerified: Bool, isRevoked: Bool) -> TransactionDisposition {
        guard isVerified else { return .unverifiedDrop }
        return isRevoked ? .revoke : .grant
    }

    /// Whether to call `transaction.finish()` given the disposition and whether
    /// the server report succeeded. A granted transaction is only finished once
    /// the server confirmed it; revoked ones always finish; unverified never do.
    static func shouldFinish(_ disposition: TransactionDisposition, reportSucceeded: Bool) -> Bool {
        switch disposition {
        case .unverifiedDrop: return false
        case .revoke: return true
        case .grant: return reportSucceeded
        }
    }

    /// Drain StoreKit's transaction updates (renewals, refunds, deferred
    /// purchases). Start once at app launch.
    static func startTransactionListener() -> Task<Void, Never> {
        Task.detached {
            let service = StoreKitService()
            for await update in Transaction.updates {
                await service.process(update)
            }
        }
    }

    /// Process one transaction update: verify, report (with bounded retry),
    /// finish per ``shouldFinish``, and nudge live billing UI to refresh.
    func process(_ update: VerificationResult<Transaction>) async {
        let transaction: Transaction
        switch update {
        case .verified(let t):
            transaction = t
        case .unverified(let t, let error):
            // Don't silently `continue` past it (the old bug) — breadcrumb it so
            // a tampered/corrupt transaction is visible, and don't grant/finish.
            Telemetry.backgroundBreadcrumb(
                "StoreKit update failed verification (product \(t.productID)): \(error.localizedDescription)",
                category: "iap")
            return
        @unknown default:
            return
        }

        let disposition = Self.disposition(
            isVerified: true, isRevoked: transaction.revocationDate != nil)
        let report = await reportWithRetry(jws: update.jwsRepresentation)
        let reportSucceeded = report != .failed

        if Self.shouldFinish(disposition, reportSucceeded: reportSucceeded) {
            await transaction.finish()
        } else {
            Telemetry.backgroundBreadcrumb(
                "StoreKit transaction left unfinished for retry "
                    + "(product \(transaction.productID), disposition \(disposition))",
                category: "iap")
        }

        // Renewal / refund / revoke all change entitlement state — let a live
        // PaywallStore re-fetch (it clears stale paid features on a refund).
        NotificationCenter.default.post(
            name: Self.entitlementsDidChangeNotification, object: nil)
    }

    /// Report a signed transaction with bounded backoff. `EdgeAPI` already
    /// retries transient network/5xx internally; this adds an outer budget for
    /// the listener so a brief server blip doesn't strand the transaction as
    /// finished-but-unreported. `ok` / `stripeConflict` are terminal.
    private func reportWithRetry(jws: String, attempts: Int = 3) async -> VerifyReport {
        var delay: UInt64 = 1_000_000_000  // 1s, doubling
        for attempt in 1...attempts {
            let result = await reportToServer(jws: jws)
            if result != .failed { return result }
            if attempt < attempts {
                try? await Task.sleep(nanoseconds: delay)
                delay *= 2
            }
        }
        return .failed
    }
}
