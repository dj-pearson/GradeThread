import Foundation

/// eBay category + item-specifics (aspects) edge client. Mirrors `CompsService`:
/// manual URLSession, Supabase token attached per request, a bare `JSONDecoder`
/// (the aspects + suggest payloads use eBay's own camelCase keys). Behind a
/// protocol so the editor model is unit-testable with an in-memory mock.
protocol AspectsProviding {
    func suggestCategories(_ query: String) async throws -> [CategorySuggestion]
    func aspects(categoryId: String) async throws -> CategoryAspectsResponse
    func extractAspects(
        itemId: String, categoryId: String, categoryPath: String?, known: [String: [String]]
    ) async throws -> ExtractAspectsResponse
}

struct EbayAspectsService: AspectsProviding {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func suggestCategories(_ query: String) async throws -> [CategorySuggestion] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        let res: CategorySuggestResponse = try await get(
            "/api/flipdesk/ebay/category/suggest",
            query: [URLQueryItem(name: "q", value: q)]
        )
        return res.suggestions
    }

    func aspects(categoryId: String) async throws -> CategoryAspectsResponse {
        try await get("/api/flipdesk/ebay/category/\(categoryId)/aspects", query: [])
    }

    func extractAspects(
        itemId: String, categoryId: String, categoryPath: String?, known: [String: [String]]
    ) async throws -> ExtractAspectsResponse {
        struct Body: Encodable {
            let item_id: String
            let category_id: String
            let category_path: String?
            let known_aspects: [String: [String]]?
        }
        return try await post(
            "/api/flipdesk/ai/extract-aspects",
            body: Body(
                item_id: itemId,
                category_id: categoryId,
                category_path: categoryPath,
                known_aspects: known.isEmpty ? nil : known
            )
        )
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem]) async throws -> T {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await send(request)
    }

    private func post<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try JSONEncoder().encode(body)
        } catch {
            throw EdgeAPIError.decoding("Encoding request failed: \(error.localizedDescription)")
        }
        return try await send(request)
    }

    private func send<T: Decodable>(_ base: URLRequest) async throws -> T {
        var request = base
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
