import Foundation

/// Two-hop eBay comps lookup against the edge service:
///   1. `GET /api/flipdesk/ebay/category/suggest?q=` → best leaf category
///   2. `GET /api/flipdesk/ebay/comps?category_id=…&q=&brand=&size=` → stats
///
/// Both endpoints sit behind the edge auth + workspace middleware, so every
/// request carries the Supabase access token (same as ``EbayPublishService``).
@MainActor
final class CompsService: CompsProviding {

    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func lookup(
        title: String, brand: String?, size: String?
    ) async throws -> CompsLookup? {
        let query = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return nil }

        // Hop 1: resolve a category from the title.
        let suggestion: CategorySuggestResponse = try await get(
            path: "/api/flipdesk/ebay/category/suggest",
            query: [URLQueryItem(name: "q", value: query)]
        )
        guard let top = suggestion.suggestions.first else { return nil }

        // Hop 2: comps within that category, narrowed by brand/size when set.
        var items = [
            URLQueryItem(name: "category_id", value: top.categoryId),
            URLQueryItem(name: "q", value: query),
        ]
        if let brand, !brand.isEmpty { items.append(URLQueryItem(name: "brand", value: brand)) }
        if let size, !size.isEmpty { items.append(URLQueryItem(name: "size", value: size)) }

        let comps: CompsResponse = try await get(
            path: "/api/flipdesk/ebay/comps", query: items
        )
        return CompsLookup(
            stats: comps.stats,
            categoryId: top.categoryId,
            categoryPath: top.categoryTreePath
        )
    }

    private func get<T: Decodable>(
        path: String, query: [URLQueryItem]
    ) async throws -> T {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        components.queryItems = query
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = await SupabaseShared.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw EdgeAPIError.network(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw EdgeAPIError.network("Non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw EdgeAPIError.from(statusCode: http.statusCode, body: data)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }
}
