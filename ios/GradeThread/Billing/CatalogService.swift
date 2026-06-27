import Foundation

/// Canonical IAP catalog DTO served by GET /api/payments/catalog. The single
/// source of truth lives server-side in
/// services/edge-functions/src/lib/appstore/products.ts (US-808); the iOS
/// `IAPCatalog` is only the offline fallback. `referencePriceDisplay` is the
/// reference/fallback price — StoreKit still provides the real localized price
/// when products load, and Apple controls the actual charged amount.
struct CatalogProduct: Codable, Equatable {
    let productId: String
    let kind: String            // "subscription" | "consumable"
    let plan: String?
    let interval: String?
    let credits: Int?
    let title: String
    let blurb: String
    let referencePriceCents: Int
    let referencePriceDisplay: String
}

struct CatalogResponse: Codable, Equatable {
    let version: Int
    let products: [CatalogProduct]
}

protocol CatalogProviding {
    /// Returns the canonical catalog, preferring the live server copy and
    /// falling back to the last cached copy when offline. Empty when neither
    /// is available (callers then use the hardcoded `IAPCatalog`).
    func loadCatalog() async -> [CatalogProduct]
}

/// Fetches the canonical IAP catalog from the edge and caches it locally so the
/// paywall has fresh tier/credit mappings + reference prices without re-fetching
/// every launch.
///
/// US-1253: the fetch routes through the shared ``EdgeAPI`` (``EdgeAPI/getJSON``)
/// rather than a bespoke `URLSession` call, so it inherits the same resilience as
/// the rest of the app — the bounded `EdgeNetwork.shared` session (so a stalled
/// request still fails fast behind the paywall spinner, App Store 2.1b), the
/// in-memory TTL cache, transient-failure retry/backoff, the forced 401
/// token-refresh, and plan-gate / telemetry interception. The server emits
/// camelCase keys, which EdgeAPI's `.convertFromSnakeCase` decoder leaves intact.
@MainActor
final class CatalogService: CatalogProviding {

    private let api: EdgeAPI
    private let cacheKey = "iap_catalog_cache_v1"

    /// Short in-memory TTL so re-opening the paywall within a session doesn't
    /// re-hit the network; the persisted UserDefaults copy remains the
    /// cross-launch offline fallback.
    private static let cacheTTL: TimeInterval = 300

    init(api: EdgeAPI = .shared) {
        self.api = api
    }

    func loadCatalog() async -> [CatalogProduct] {
        if let fresh: CatalogResponse = try? await api.getJSON(
            "/api/payments/catalog", cacheTTL: Self.cacheTTL
        ) {
            cache(fresh)
            return fresh.products
        }
        return cached()?.products ?? []
    }

    // MARK: - Cache (UserDefaults; small + non-sensitive reference data)

    private func cache(_ response: CatalogResponse) {
        if let data = try? JSONEncoder().encode(response) {
            UserDefaults.standard.set(data, forKey: cacheKey)
        }
    }

    private func cached() -> CatalogResponse? {
        guard let data = UserDefaults.standard.data(forKey: cacheKey) else { return nil }
        return try? JSONDecoder().decode(CatalogResponse.self, from: data)
    }
}
