import Foundation

/// Generated eBay listing copy from `POST /api/flipdesk/ai/listing-copy`.
/// Only `title` + `description` are consumed here; the endpoint also returns
/// `model` / `log_id` / `actions_remaining`, which decode away cleanly.
struct ListingCopy: Decodable, Equatable {
    let title: String
    let description: String
}

/// Friendly errors for the AI-copy flow, mapped from the endpoint's HTTP
/// statuses so the composer can show actionable text instead of raw codes.
enum ListingCopyError: LocalizedError, Equatable {
    case itemNotSynced
    case quotaReached
    case unavailable
    case other(String)

    var errorDescription: String? {
        switch self {
        case .itemNotSynced:
            return "Save and sync this item first, then generate its listing copy."
        case .quotaReached:
            return "You've hit your monthly AI limit. It resets next cycle — or upgrade for a higher cap."
        case .unavailable:
            return "AI listing generation is temporarily unavailable. Try again shortly."
        case .other(let message):
            return message
        }
    }
}

/// Abstraction so the composer's AI button is unit-testable with a fake.
@MainActor
protocol ListingCopyGenerating {
    func generate(itemId: String) async throws -> ListingCopy
}

/// Calls the edge AI route to draft an eBay title + description from an
/// inventory item's attributes + photos. The item must already exist
/// server-side (the endpoint reads `inventory_items` by id) — locally-created
/// rows that haven't synced yet 404 and surface as ``ListingCopyError/itemNotSynced``.
@MainActor
final class ListingCopyService: ListingCopyGenerating {

    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func generate(itemId: String) async throws -> ListingCopy {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/flipdesk/ai/listing-copy"
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
        request.httpBody = try JSONEncoder().encode(Request(itemId: itemId))

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
            return try JSONDecoder().decode(ListingCopy.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }

    /// Maps the endpoint's documented statuses: 404 (item not found / unsynced),
    /// 402 + 429 (quota gate / atomic-reservation exhaustion), 502 (AI down).
    private static func mapError(status: Int, body: Data) -> Error {
        switch status {
        case 404:        return ListingCopyError.itemNotSynced
        case 402, 429:   return ListingCopyError.quotaReached
        case 502:        return ListingCopyError.unavailable
        default:
            let parsed = try? JSONDecoder().decode(EdgeErrorBody.self, from: body)
            return ListingCopyError.other(parsed?.message ?? "Couldn't generate copy (HTTP \(status)).")
        }
    }

    /// Body encodes to `{ "item_id": … }` to match the edge route's snake_case key.
    private struct Request: Encodable {
        let itemId: String
        enum CodingKeys: String, CodingKey { case itemId = "item_id" }
    }
}
