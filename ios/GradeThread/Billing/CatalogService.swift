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
/// every launch. Mirrors the request shape of the other edge services
/// (``CompsService``): GET behind the edge auth middleware with the Supabase
/// access token.
@MainActor
final class CatalogService: CatalogProviding {

    private let baseURL: URL
    private let session: URLSession
    private let cacheKey = "iap_catalog_cache_v1"

    // US-992 parity: use the bounded `EdgeNetwork.shared` session (20s idle
    // timeout), NOT `URLSession.shared` (60s). The paywall `await`s this fetch
    // before StoreKit, so a stalled catalog request must fail fast instead of
    // hanging the paywall behind its spinner for up to a minute (App Store 2.1b).
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func loadCatalog() async -> [CatalogProduct] {
        if let fresh = try? await fetch() {
            cache(fresh)
            return fresh.products
        }
        return cached()?.products ?? []
    }

    // MARK: - Network

    private func fetch() async throws -> CatalogResponse {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/payments/catalog"
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build catalog URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = await SupabaseShared.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw EdgeAPIError.network("Non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw EdgeAPIError.from(statusCode: http.statusCode, body: data)
        }
        return try JSONDecoder().decode(CatalogResponse.self, from: data)
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
