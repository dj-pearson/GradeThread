import Foundation

/// Calls `POST /api/flipdesk/ai/extract`. Bypasses the generic ``EdgeAPI``
/// because the response's `suggestions` dictionary has field-name keys
/// (`brand`, `size`, `garment_category`) that we need to preserve verbatim
/// — `EdgeAPI`'s shared decoder applies snake-to-camel conversion to every
/// key in scope, which would mangle them. The auth-token attachment and
/// error-mapping logic are still reused via ``SupabaseShared`` and
/// ``EdgeAPIError``.
@MainActor
final class AIExtractService {
    private let baseURL: URL
    private let session: URLSession

    // US-992: defaults to the bounded-timeout edge session so an extract call
    // can't hang ~60s behind a spinner on flaky cellular.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func extract(_ request: AIExtractRequest) async throws -> AIExtractResponse {
        // US-1164: guard instead of force-unwrapping a malformed base URL.
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw EdgeAPIError.network("Could not build request URL")
        }
        components.path = "/api/flipdesk/ai/extract"
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL")
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = await SupabaseShared.currentAccessToken() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        // Request body has explicit CodingKeys → no global key strategy
        // needed. Keep the encoder bare so we don't apply a strategy that
        // would conflict with the keys we declared.
        let encoder = JSONEncoder()
        do {
            req.httpBody = try encoder.encode(request)
        } catch {
            throw EdgeAPIError.decoding("Encoding extract request failed: \(error.localizedDescription)")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw EdgeAPIError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw EdgeAPIError.network("Non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw EdgeAPIError.from(statusCode: http.statusCode, body: data)
        }

        // No key-conversion strategy — preserves the field-name keys in
        // `suggestions` and `measurements` exactly as the server emitted.
        do {
            return try JSONDecoder().decode(AIExtractResponse.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }
}
