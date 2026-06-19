import Foundation

/// Abstraction over the Prospecting network calls so ``ProspectStore`` can be
/// unit-tested with a fake (no network).
@MainActor
protocol Prospecting {
    /// Identify + comp an item from 1–2 photos (front + tag).
    func prospect(images: [Data], costCents: Int?) async throws -> ProspectResponse
    /// Commit a prospected item into inventory at `sourced`.
    func buy(_ request: ProspectBuyRequest) async throws -> ProspectBuyResponse
}

/// Talks to the edge `/api/flipdesk/scout/prospect` + `/buy` routes. Uses a
/// *plain* `JSONEncoder`/`JSONDecoder` (no key-strategy conversion) because the
/// scout routes read/return camelCase — same convention as ``ScoutService``.
/// Photos are sent as base64 JPEG data URIs; the edge never stores them.
@MainActor
final class ProspectService: Prospecting {

    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func prospect(images: [Data], costCents: Int?) async throws -> ProspectResponse {
        let dataURIs = images.map { "data:image/jpeg;base64," + $0.base64EncodedString() }
        let body = ProspectRequest(images: dataURIs, costCents: costCents)
        return try await post(path: "/api/flipdesk/scout/prospect", body: body)
    }

    func buy(_ request: ProspectBuyRequest) async throws -> ProspectBuyResponse {
        return try await post(path: "/api/flipdesk/scout/buy", body: request)
    }

    // MARK: - Transport

    private func post<Body: Encodable, T: Decodable>(path: String, body: Body) async throws -> T {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await send(request)
    }

    private func send<T: Decodable>(_ unauthorized: URLRequest) async throws -> T {
        var request = unauthorized
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
            // 402 = plan gate / quota cap (compPulls is Pro+). Surface a friendly
            // upsell via the shared ``ScoutError`` rather than a raw code.
            if http.statusCode == 402, let gate = try? JSONDecoder().decode(ProspectGateBody.self, from: data) {
                if gate.error == "CAP_REACHED" || gate.cap != nil {
                    throw ScoutError.quotaReached
                }
                throw ScoutError.planLocked(requiredPlan: gate.requiredPlan)
            }
            throw EdgeAPIError.from(statusCode: http.statusCode, body: data)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }
}

/// Subset of the 402 plan-gate body (`{ error, requiredPlan, cap, … }`).
private struct ProspectGateBody: Decodable {
    let error: String?
    let requiredPlan: String?
    let cap: String?
}
