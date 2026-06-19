import Foundation

// US-745: the Listing Kit's only network dependency. Protocol-based so the
// store can be unit-tested with a fake (mirrors AutolisterBatching /
// TemplateProviding). The single POST consumes the existing web endpoint —
// no marketplace logic lives on the client.

protocol ListingKitProviding {
    /// Generate per-platform listing fields for an item that already has an eBay
    /// draft. Throws `EdgeAPIError` (e.g. 409 when the item has no eBay draft yet).
    func platformFields(itemId: String, platforms: [String]) async throws -> ListingKitResponse
}

struct ListingKitService: ListingKitProviding {
    private let api: EdgeAPI

    init(api: EdgeAPI = .shared) {
        self.api = api
    }

    /// Encodes to `{ "item_id": "...", "platforms": [...] }` via the shared
    /// convertToSnakeCase encoder.
    private struct RequestBody: Encodable {
        let itemId: String
        let platforms: [String]
    }

    func platformFields(itemId: String, platforms: [String]) async throws -> ListingKitResponse {
        try await api.postJSON(
            "/api/flipdesk/autolister/platform-fields",
            body: RequestBody(itemId: itemId, platforms: platforms)
        )
    }
}
