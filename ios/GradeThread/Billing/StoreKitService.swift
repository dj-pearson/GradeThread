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
                    await reportToServer(jws: verification.jwsRepresentation)
                    await transaction.finish()
                    return .success
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

    /// Send the signed transaction to the edge, which verifies + reconciles it
    /// into the user's plan/credits. Entitlement is also delivered server-side by
    /// App Store Server Notifications, so a transient failure here self-heals.
    private func reportToServer(jws: String) async {
        struct Body: Encodable { let jws: String }
        let _: AppStoreVerifyResponse? = try? await api.postJSON(
            "/api/payments/appstore/verify", body: Body(jws: jws))
    }

    /// Drain StoreKit's transaction updates (renewals, refunds, deferred
    /// purchases): report + finish each verified one. Start once at app launch.
    static func startTransactionListener() -> Task<Void, Never> {
        Task.detached {
            let service = StoreKitService()
            for await update in Transaction.updates {
                guard case .verified(let transaction) = update else { continue }
                await service.reportToServer(jws: update.jwsRepresentation)
                await transaction.finish()
            }
        }
    }
}
