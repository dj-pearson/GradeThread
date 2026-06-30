import Foundation

/// Friendly errors for the repricing flow.
enum RepricingError: LocalizedError, Equatable {
    case ebayNotConfigured
    case applyFailed(String)
    case other(String)

    var errorDescription: String? {
        switch self {
        case .ebayNotConfigured:
            return "eBay isn't connected on this account yet. Connect it under Marketplaces first."
        case .applyFailed(let message):
            return message
        case .other(let message):
            return message
        }
    }
}

/// Abstraction so ``RepricingStore`` can be unit-tested with a fake.
@MainActor
protocol RepricingProviding {
    func suggestions() async throws -> [RepricingSuggestion]
    /// Applies a suggestion; returns the new price (dollars).
    func apply(id: String) async throws -> Double
    func dismiss(id: String) async throws
    /// Triggers a fresh scan of active listings; returns the result counts.
    func scan() async throws -> RepricingScanResult
}

/// Talks to the edge repricing route. Responses are raw snake_case Supabase
/// rows, so this uses a `.convertFromSnakeCase` decoder (unlike Scout's plain
/// decoder). Apply/dismiss take no body.
@MainActor
final class RepricingService: RepricingProviding {

    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder

    // US-1407: bounded session (was `URLSession.shared` = 60s) so repricing
    // load/scan fails fast instead of hanging.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.shared) {
        self.baseURL = baseURL
        self.session = session
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = d
    }

    func suggestions() async throws -> [RepricingSuggestion] {
        let response: RepricingSuggestionsResponse = try await send(
            path: "/api/flipdesk/pricing/suggestions", method: "GET"
        )
        return response.suggestions
    }

    func apply(id: String) async throws -> Double {
        let response: RepricingApplyResponse = try await send(
            path: "/api/flipdesk/pricing/suggestions/\(id)/apply", method: "POST"
        )
        return response.newPrice ?? 0
    }

    func dismiss(id: String) async throws {
        let _: DismissResponse = try await send(
            path: "/api/flipdesk/pricing/suggestions/\(id)/dismiss", method: "POST"
        )
    }

    func scan() async throws -> RepricingScanResult {
        try await send(path: "/api/flipdesk/pricing/scan", method: "POST")
    }

    // MARK: - Transport

    private struct DismissResponse: Decodable { let dismissed: Bool }

    private func send<T: Decodable>(path: String, method: String) async throws -> T {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
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
            throw Self.mapError(status: http.statusCode, body: data)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }

    /// 503 = eBay not configured; 502 = apply couldn't push to eBay (left
    /// pending, retryable). Other statuses fall back to the body's `error`.
    private static func mapError(status: Int, body: Data) -> Error {
        let message = (try? JSONDecoder().decode(WireError.self, from: body))?.error
        switch status {
        case 503: return RepricingError.ebayNotConfigured
        case 502: return RepricingError.applyFailed(
            message ?? "Couldn't update the price on eBay — left unapplied so you can retry."
        )
        default:  return RepricingError.other(message ?? "Something went wrong (HTTP \(status)).")
        }
    }

    private struct WireError: Decodable { let error: String? }
}
