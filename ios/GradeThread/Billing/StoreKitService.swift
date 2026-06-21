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
    /// productId → localized display price (e.g. "$59.00"). Empty on failure.
    func loadPrices(ids: [String]) async -> [String: String]
    /// Buy a product; on a verified transaction, report it to the edge + finish it.
    func purchase(productId: String, appAccountToken: UUID) async -> PurchaseOutcome
    func restore() async
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

struct StoreKitService: StoreKitProviding {
    private let api: EdgeAPI

    init(api: EdgeAPI = .shared) {
        self.api = api
    }

    func loadPrices(ids: [String]) async -> [String: String] {
        do {
            let products = try await Product.products(for: ids)
            var map: [String: String] = [:]
            for product in products { map[product.id] = product.displayPrice }
            return map
        } catch {
            return [:]
        }
    }

    func purchase(productId: String, appAccountToken: UUID) async -> PurchaseOutcome {
        do {
            let products = try await Product.products(for: [productId])
            guard let product = products.first else {
                return .failed("This item is unavailable right now.")
            }
            let result = try await product.purchase(options: [.appAccountToken(appAccountToken)])
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    let report = await reportToServer(jws: verification.jwsRepresentation)
                    await transaction.finish()
                    return report == .stripeConflict ? .stripeConflict : .success
                case .unverified:
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
            return .failed(error.localizedDescription)
        }
    }

    func restore() async {
        try? await AppStore.sync()
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
            return .failed
        } catch {
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
