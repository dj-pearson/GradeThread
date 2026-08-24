import Foundation

/// eBay category + item-specifics (aspects) edge client. Mirrors `CompsService`:
/// manual URLSession, Supabase token attached per request, a bare `JSONDecoder`
/// (the aspects + suggest payloads use eBay's own camelCase keys). Behind a
/// protocol so the editor model is unit-testable with an in-memory mock.
protocol AspectsProviding {
    func suggestCategories(_ query: String) async throws -> [CategorySuggestion]
    /// `category` is the ITEM's vertical (clothing / shoes / ...), not the eBay
    /// leaf. It only decides which name each column owns in the
    /// columnBackedAspects map -- a shoe's size column owns "US Shoe Size", a
    /// shirt's owns "Size". Pass nil when the item has no category set and the
    /// server falls back to the generic names.
    func aspects(categoryId: String, category: String?) async throws -> CategoryAspectsResponse
    func extractAspects(
        itemId: String, categoryId: String, categoryPath: String?, known: [String: [String]]
    ) async throws -> ExtractAspectsResponse
    /// US-824: deterministic, NO-AI refill of a category's aspects from the
    /// item's own data — called when the seller switches category.
    func deriveAspects(
        itemId: String, categoryId: String, known: [String: [String]]
    ) async throws -> DeriveAspectsResponse
    /// Fold specifics-editor edits back into the item's Brand/Size/Color/
    /// Material/Style columns, so those five are entered ONCE wherever the
    /// seller typed them. The columns are the write-authority at publish and in
    /// ``InventoryAspectSync``, so without this an aspect typed here is
    /// clobbered by the stale column on the next item save. Web does the same
    /// write inline (composer `aspectWriteBackPatch`).
    @discardableResult
    func writeBackAspectColumns(
        itemId: String, aspects: [String: [String]], sources: [String: String]
    ) async throws -> [String: String]
}

struct EbayAspectsService: AspectsProviding {
    private let baseURL: URL
    private let session: URLSession
    /// US-1407: the AI extract (`/ai/extract-aspects`) does 20-60s of idle model
    /// work, so it needs the generous AI session — using the bounded `session`
    /// would kill a successful extract mid-flight. The fast category/aspects GETs
    /// stay on the bounded `session` so a stall fails fast (was `URLSession.shared`
    /// = 60s, which hung the specifics UI behind "Loading item specifics…").
    private let aiSession: URLSession

    init(
        baseURL: URL = AppConfig.edgeAPIURL,
        session: URLSession = EdgeNetwork.shared,
        aiSession: URLSession = EdgeNetwork.aiSession
    ) {
        self.baseURL = baseURL
        self.session = session
        self.aiSession = aiSession
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

    func aspects(categoryId: String, category: String?) async throws -> CategoryAspectsResponse {
        let vertical = (category ?? "").trimmingCharacters(in: .whitespaces)
        return try await get(
            "/api/flipdesk/ebay/category/\(categoryId)/aspects",
            query: vertical.isEmpty
                ? []
                : [URLQueryItem(name: "category", value: vertical)]
        )
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
            ),
            session: aiSession  // US-1407: slow AI inference — use the AI session.
        )
    }

    func deriveAspects(
        itemId: String, categoryId: String, known: [String: [String]]
    ) async throws -> DeriveAspectsResponse {
        struct Body: Encodable {
            let itemId: String
            let knownAspects: [String: [String]]?
        }
        return try await post(
            "/api/flipdesk/ebay/category/\(categoryId)/derive-aspects",
            body: Body(itemId: itemId, knownAspects: known.isEmpty ? nil : known)
        )
    }

    @discardableResult
    func writeBackAspectColumns(
        itemId: String, aspects: [String: [String]], sources: [String: String]
    ) async throws -> [String: String] {
        struct Body: Encodable {
            let itemId: String
            let aspects: [String: [String]]
            let sources: [String: String]
        }
        struct Response: Decodable { let updated: [String: String]? }
        let res: Response = try await post(
            "/api/flipdesk/ebay/aspects/write-back",
            body: Body(itemId: itemId, aspects: aspects, sources: sources)
        )
        return res.updated ?? [:]
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

    private func post<B: Encodable, T: Decodable>(
        _ path: String, body: B, session: URLSession? = nil
    ) async throws -> T {
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
        return try await send(request, session: session)
    }

    private func send<T: Decodable>(_ base: URLRequest, session: URLSession? = nil) async throws -> T {
        var request = base
        if let token = await SupabaseShared.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await (session ?? self.session).data(for: request)
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
