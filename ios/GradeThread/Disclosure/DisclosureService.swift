import Foundation

/// Defect-disclosure edge client. Thin wrapper over `EdgeAPI.shared` (auto-auth,
/// snake_case ⇄ camelCase). Endpoints already exist on the Hono service and are
/// mounted at `/api/flipdesk/disclosure/*`. Behind a protocol so the store is
/// unit-testable with an in-memory mock (mirrors `AspectsProviding`).
protocol DisclosureProviding {
    func disclosure(itemId: String) async throws -> DisclosureData
    func saveAnnotated(itemId: String, imageType: String, dataURL: String) async throws -> SaveAnnotatedResponse
    func applyToListing(itemId: String) async throws -> ApplyDisclosureResponse
}

struct DisclosureService: DisclosureProviding {
    private let api: EdgeAPI

    init(api: EdgeAPI = .shared) {
        self.api = api
    }

    private func base(_ itemId: String) -> String {
        "/api/flipdesk/disclosure/item/\(itemId)"
    }

    func disclosure(itemId: String) async throws -> DisclosureData {
        try await api.getJSON(base(itemId))
    }

    func saveAnnotated(itemId: String, imageType: String, dataURL: String) async throws -> SaveAnnotatedResponse {
        // imageType → image_type, dataUrl → data_url via the shared encoder.
        struct Body: Encodable {
            let imageType: String
            let dataUrl: String
        }
        return try await api.postJSON(
            "\(base(itemId))/annotated-photo",
            body: Body(imageType: imageType, dataUrl: dataURL)
        )
    }

    func applyToListing(itemId: String) async throws -> ApplyDisclosureResponse {
        struct Empty: Encodable {}
        return try await api.postJSON("\(base(itemId))/apply-to-listing", body: Empty())
    }
}
