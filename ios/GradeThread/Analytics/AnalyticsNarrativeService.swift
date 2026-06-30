import Foundation

/// AI period narrative from `POST /api/flipdesk/ai/analytics-narrative`
/// (US-1169). The client computes its period rollups locally and posts the
/// numbers; the edge returns a plain-language summary, highlights and next
/// actions.
struct AnalyticsNarrative: Decodable, Equatable {
    let summary: String
    let highlights: [String]
    let actions: [String]
}

/// The locally-computed period rollup the client posts for narration. Mirrors
/// the edge route's snake_case body keys.
struct AnalyticsRollupPayload: Encodable {
    let periodLabel: String
    let grossRevenue: Double
    let fees: Double
    let cogs: Double
    let unitsSold: Int
    let sellThroughRate: Double?
    let gradingRoiLift: Double?
    let topBrand: String?
    let currency: String

    enum CodingKeys: String, CodingKey {
        case periodLabel = "period_label"
        case grossRevenue = "gross_revenue"
        case fees
        case cogs
        case unitsSold = "units_sold"
        case sellThroughRate = "sell_through_rate"
        case gradingRoiLift = "grading_roi_lift"
        case topBrand = "top_brand"
        case currency
    }
}

/// Abstraction so the analytics summary card is unit-testable with a fake.
@MainActor
protocol AnalyticsNarrating {
    func narrate(_ payload: AnalyticsRollupPayload) async throws -> AnalyticsNarrative
}

/// Calls the edge AI route to narrate a period's financials. Reuses the
/// ListingCopyService transport pattern (bearer token, JSON, friendly errors).
@MainActor
final class AnalyticsNarrativeService: AnalyticsNarrating {

    private let baseURL: URL
    private let session: URLSession

    // US-1407: AI inference (`/ai/analytics-narrative`) — generous AI session.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.aiSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func narrate(_ payload: AnalyticsRollupPayload) async throws -> AnalyticsNarrative {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/flipdesk/ai/analytics-narrative"
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = await SupabaseShared.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONEncoder().encode(payload)

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
            return try JSONDecoder().decode(AnalyticsNarrative.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }

    /// Reuses ``ListingCopyError`` for the shared quota/unavailable statuses.
    private static func mapError(status: Int, body: Data) -> Error {
        switch status {
        case 402, 429:   return ListingCopyError.quotaReached
        case 502:        return ListingCopyError.unavailable
        default:
            let parsed = try? JSONDecoder().decode(EdgeErrorBody.self, from: body)
            return ListingCopyError.other(parsed?.message ?? "Couldn't generate a summary (HTTP \(status)).")
        }
    }
}
