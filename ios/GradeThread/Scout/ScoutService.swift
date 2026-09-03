import Foundation

/// Abstraction over the ScoutAI network calls so ``ScoutStore`` can be
/// unit-tested with a fake (no network).
@MainActor
protocol ScoutScanning {
    /// Resolves a sharper eBay leaf category from free text (reuses the same
    /// `/category/suggest` hop as comps). Returns nil when nothing resolves —
    /// the caller then falls back to the broad apparel root.
    func suggestCategory(for query: String) async throws -> CategorySuggestion?

    /// Runs a scan: searches eBay within `categoryId` (narrowed by q/brand),
    /// shadow-grades each candidate, and returns them ranked.
    func scan(categoryId: String, q: String?, brand: String?, limit: Int) async throws -> ScoutScanResponse

    /// US-3097: commit a candidate the seller actually bought into inventory at
    /// `sourced`, with the asking price as the cost basis. Same
    /// `/api/flipdesk/scout/buy` route Prospect already posts to — a scout row
    /// and a prospected garment become the same kind of inventory row, so
    /// giving this one its own endpoint would be two ways to make one thing.
    func buy(_ request: ProspectBuyRequest) async throws -> ProspectBuyResponse
}

/// Talks to the edge ScoutAI route. Uses a *plain* `JSONEncoder`/`JSONDecoder`
/// (no key-strategy conversion) because the `/scout` route reads camelCase
/// body keys (`categoryId`) and returns camelCase — same convention as
/// ``EbayPublishService`` and ``CompsService``, NOT the snake-casing
/// `EdgeAPI.shared`.
@MainActor
final class ScoutService: ScoutScanning {

    private let baseURL: URL
    private let session: URLSession

    // A scan is an AI-INFERENCE call, not a normal request. The edge grades up
    // to `MAX_CANDIDATES` listings from their photos and streams NOTHING until
    // the ranked JSON is ready, so the connection sits legitimately idle for the
    // whole run. US-1407 put this on the 20s-idle `EdgeNetwork.shared` to stop
    // hangs; that ceiling is shorter than a SINGLE candidate's grade (~15-25s
    // observed), so every scan timed out client-side while the server kept
    // grading and billing. `aiSession` is the session built for exactly this
    // shape — see `EdgeNetwork.aiRequestTimeout`.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.aiSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func suggestCategory(for query: String) async throws -> CategorySuggestion? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return nil }
        let response: CategorySuggestResponse = try await get(
            path: "/api/flipdesk/ebay/category/suggest",
            query: [URLQueryItem(name: "q", value: q)]
        )
        return response.suggestions.first
    }

    func scan(categoryId: String, q: String?, brand: String?, limit: Int) async throws -> ScoutScanResponse {
        let body = ScoutScanRequest(categoryId: categoryId, q: q, brand: brand, limit: limit)
        return try await post(path: "/api/flipdesk/scout", body: body)
    }

    func buy(_ request: ProspectBuyRequest) async throws -> ProspectBuyResponse {
        // NOTE: the route takes no eBay item id — it writes an inventory_items
        // row from title/brand/size/color/cost/target/grade and nothing else
        // (routes/flipdesk-scout.ts). Sending the candidate's itemId would be
        // silently dropped, so it is not sent; the listing is identified by its
        // title and the price the seller paid.
        return try await post(path: "/api/flipdesk/scout/buy", body: request)
    }

    // MARK: - Transport

    private func get<T: Decodable>(path: String, query: [URLQueryItem]) async throws -> T {
        // US-1164: guard instead of force-unwrapping a malformed base URL.
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw EdgeAPIError.network("Could not build request URL")
        }
        components.path = path
        components.queryItems = query
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        return try await send(URLRequest(authorizing: url, method: "GET"))
    }

    private func post<Body: Encodable, T: Decodable>(path: String, body: Body) async throws -> T {
        // US-1164: guard instead of force-unwrapping a malformed base URL.
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw EdgeAPIError.network("Could not build request URL")
        }
        components.path = path
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL for \(path)")
        }
        var request = URLRequest(authorizing: url, method: "POST")
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
            // 402 = plan gate / quota cap. US-1213: route through the SAME
            // ``PlanGateError`` decode + ``PlanGateNotifier`` hook that
            // ``EdgeAPI`` uses, so the centralized upgrade-prompt → paywall flow
            // fires here too (a free user gets a tappable CTA, not a dead-end
            // "Try again"). The bespoke transport stays because the `/scout`
            // route speaks camelCase, which the snake-casing `EdgeAPI.shared`
            // decoder would mangle; `PlanGateError.decode` uses a plain decoder,
            // so the gate body decodes identically either way.
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

/// Plan-gate / quota errors (HTTP 402) from the Scout endpoint, mapped to a
/// friendly upsell instead of a raw `FEATURE_LOCKED` / `CAP_REACHED` code.
///
/// US-1213: every case here is a plan gate (a 402), never a transient failure,
/// so ``isPlanGated`` is always true. It's exposed so callers can distinguish
/// "the centralized upgrade prompt is already handling this" (suppress a
/// "Try again" that would just re-hit the gate) from a transient network error
/// (where retry is the right recovery). Transient failures surface as
/// ``EdgeAPIError`` instead, for which `isPlanGated` is false.
enum ScoutError: LocalizedError, Equatable {
    case planLocked(requiredPlan: String?)
    case quotaReached

    var errorDescription: String? {
        switch self {
        case .planLocked(let plan):
            let tier = plan?.capitalized ?? "Pro"
            return "ScoutAI is a \(tier) feature. Upgrade your plan (Settings → Plan) to start scouting deals."
        case .quotaReached:
            return "You've hit your monthly AI scan limit. It resets next cycle — or upgrade for a higher cap."
        }
    }

    /// True for any plan-gate (402) error — the centralized upgrade prompt is
    /// already presenting an upsell, so a retry button would only re-hit the gate.
    var isPlanGated: Bool { true }
}

/// US-1213: classifies an arbitrary thrown error as plan-gated (a 402 already
/// routed to the upgrade prompt) vs. transient, so a failure UI can hide a
/// dead-end "Try again" for the former while keeping it for the latter.
///
/// US-1866 folds ``RadarError`` in: the Radar network layer is gated on the
/// same `compPulls` flag, so a caller asking "was that a plan wall?" must get
/// the same answer whichever surface threw.
func isPlanGateError(_ error: Error) -> Bool {
    if let scout = error as? ScoutError { return scout.isPlanGated }
    if let radar = error as? RadarError { return radar.isPlanGated }
    return false
}

private extension URLRequest {
    /// Small ctor that sets the method + Accept header; the bearer token is
    /// attached later in `send` (async).
    init(authorizing url: URL, method: String) {
        self.init(url: url)
        httpMethod = method
        setValue("application/json", forHTTPHeaderField: "Accept")
    }
}
