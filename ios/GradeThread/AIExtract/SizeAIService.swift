import Foundation

/// Calls `POST /api/flipdesk/ai/size` (US-1088). Infers a best-guess size +
/// gender/department from the item's photos — prioritizing measurement / flat-lay
/// shots — compared against the brand's sizing chart, for items whose size label
/// is missing or cut off (Lululemon is the motivating case).
///
/// US-1164: routes through ``EdgeAPI/sendRaw`` (backed by ``EdgeAPI/aiShared``'s
/// long-idle session) so it inherits the shared transient retry/backoff, one
/// forced 401 token-refresh, and plan-gate handling, while keeping its own bare
/// codec for the explicit-CodingKeys request/response.
@MainActor
final class SizeAIService {
    struct Request: Encodable {
        let itemId: String
        enum CodingKeys: String, CodingKey { case itemId = "item_id" }
    }

    struct Response: Decodable {
        let size: String
        let gender: String?
        let confidence: Double
        let rationale: String
        let lowConfidence: Bool
        enum CodingKeys: String, CodingKey {
            case size, gender, confidence, rationale
            case lowConfidence = "low_confidence"
        }
    }

    private let edge: EdgeAPI

    init(edge: EdgeAPI = .aiShared) {
        self.edge = edge
    }

    func estimate(itemId: String) async throws -> Response {
        let bodyData: Data
        do {
            bodyData = try JSONEncoder().encode(Request(itemId: itemId))
        } catch {
            throw EdgeAPIError.decoding(
                "Encoding size request failed: \(error.localizedDescription)")
        }

        let data = try await edge.sendRaw(
            method: "POST", path: "/api/flipdesk/ai/size", bodyData: bodyData)

        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }
}
