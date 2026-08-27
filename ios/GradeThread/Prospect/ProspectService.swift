import Foundation

/// Abstraction over the Prospecting network calls so ``ProspectStore`` can be
/// unit-tested with a fake (no network).
@MainActor
protocol Prospecting {
    /// Run a prospect request: either an ordinary scan (photos plus their roles)
    /// or a US-2923 re-pull (a corrected title, no photos).
    ///
    /// One method rather than two, because it is one endpoint returning one
    /// response shape — which is what lets the store swap a re-pull's result
    /// straight in. ``ProspectRequest/repull(title:brand:gradeValue:gradeTier:costCents:)``
    /// is what distinguishes the two at the call site.
    func prospect(_ request: ProspectRequest) async throws -> ProspectResponse
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

    // A prospect run is an AI-INFERENCE call: the edge identifies the garment
    // from the photos AND shadow-grades it before it comps anything, and it
    // streams nothing until the whole result is ready. The 20s idle ceiling on
    // `EdgeNetwork.shared` (US-1407) is shorter than that work, so a run that
    // succeeded server-side surfaced as a network error in the app. Same
    // reasoning as `SnapService`, which already uses this session.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.aiSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func prospect(_ request: ProspectRequest) async throws -> ProspectResponse {
        return try await post(path: "/api/flipdesk/scout/prospect", body: request)
    }

    func buy(_ request: ProspectBuyRequest) async throws -> ProspectBuyResponse {
        return try await post(path: "/api/flipdesk/scout/buy", body: request)
    }

    // MARK: - Transport

    private func post<Body: Encodable, T: Decodable>(path: String, body: Body) async throws -> T {
        // US-1164: guard instead of force-unwrapping a malformed base URL.
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw EdgeAPIError.network("Could not build request URL")
        }
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
            // 402 = plan gate / quota cap (compPulls is Pro+). US-1213: route
            // through the SAME ``PlanGateError`` decode + ``PlanGateNotifier``
            // hook that ``EdgeAPI`` uses, so the centralized upgrade-prompt →
            // paywall flow fires here too. The bespoke transport stays (the
            // scout routes speak camelCase, which the snake-casing
            // `EdgeAPI.shared` decoder would mangle); `PlanGateError.decode` uses
            // a plain decoder, so the gate body decodes identically either way.
            if http.statusCode == 402, let gate = PlanGateError.decode(from: data) {
                PlanGateNotifier.shared.present(gate)
                if gate.isFeatureLock {
                    throw ScoutError.planLocked(requiredPlan: gate.requiredPlan)
                }
                throw ScoutError.quotaReached
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
