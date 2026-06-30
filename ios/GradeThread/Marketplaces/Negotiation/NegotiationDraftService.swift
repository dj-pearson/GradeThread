import Foundation

/// AI negotiation draft + counter-offer validation from
/// `POST /api/flipdesk/ai/negotiate` (US-1168). The edge runs the pure
/// counter-offer guardrail (suggested counter, warnings) and the LLM drafter in
/// one call; the sheet uses `message` to prefill its note and `suggestedCounter`
/// to prefill / sanity-check the price.
struct NegotiationDraft: Decodable, Equatable {
    let message: String
    let suggestedCounter: Double?
    let warnings: [String]

    enum CodingKeys: String, CodingKey {
        case message
        case suggestedCounter = "suggested_counter"
        case warnings
    }
}

/// Which draft we want — a counter (proposes the suggested price) or a plain
/// reply to a buyer message. Mirrors the edge route's `mode`.
enum NegotiationDraftMode: String { case counter, reply }

/// Abstraction so the negotiation sheets' AI button is unit-testable with a fake.
@MainActor
protocol NegotiationDrafting {
    func draft(
        itemId: String,
        mode: NegotiationDraftMode,
        offerPrice: Double?,
        currency: String,
        buyerMessage: String?,
        proposedCounter: Double?
    ) async throws -> NegotiationDraft
}

/// Calls the edge AI route to draft a counter/reply and validate a counter
/// price. Reuses the ListingCopyService transport pattern: bearer token, JSON
/// body, friendly error mapping for the quota/unavailable statuses.
@MainActor
final class NegotiationDraftService: NegotiationDrafting {

    private let baseURL: URL
    private let session: URLSession

    // US-1407: AI inference (`/ai/negotiate`) — generous AI session.
    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = EdgeNetwork.aiSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func draft(
        itemId: String,
        mode: NegotiationDraftMode,
        offerPrice: Double?,
        currency: String,
        buyerMessage: String?,
        proposedCounter: Double?
    ) async throws -> NegotiationDraft {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/flipdesk/ai/negotiate"
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
        request.httpBody = try JSONEncoder().encode(
            Request(
                itemId: itemId, mode: mode.rawValue, offerPrice: offerPrice,
                currency: currency, buyerMessage: buyerMessage,
                proposedCounter: proposedCounter
            )
        )

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
            return try JSONDecoder().decode(NegotiationDraft.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }

    /// Reuses ``ListingCopyError`` so the negotiation sheets get the same
    /// actionable text for the shared statuses: 404 (item unsynced), 402/429
    /// (quota), 502 (AI down).
    private static func mapError(status: Int, body: Data) -> Error {
        switch status {
        case 404:        return ListingCopyError.itemNotSynced
        case 402, 429:   return ListingCopyError.quotaReached
        case 502:        return ListingCopyError.unavailable
        default:
            let parsed = try? JSONDecoder().decode(EdgeErrorBody.self, from: body)
            return ListingCopyError.other(parsed?.message ?? "Couldn't draft a reply (HTTP \(status)).")
        }
    }

    private struct Request: Encodable {
        let itemId: String
        let mode: String
        let offerPrice: Double?
        let currency: String
        let buyerMessage: String?
        let proposedCounter: Double?
        enum CodingKeys: String, CodingKey {
            case itemId = "item_id"
            case mode
            case offerPrice = "offer_price"
            case currency
            case buyerMessage = "buyer_message"
            case proposedCounter = "proposed_counter"
        }
    }
}
