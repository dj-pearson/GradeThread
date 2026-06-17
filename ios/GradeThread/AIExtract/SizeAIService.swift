import Foundation

/// Calls `POST /api/flipdesk/ai/size` (US-1088). Infers a best-guess size +
/// gender/department from the item's photos — prioritizing measurement / flat-lay
/// shots — compared against the brand's sizing chart, for items whose size label
/// is missing or cut off (Lululemon is the motivating case). Mirrors
/// ``AIExtractService``'s auth + error-mapping pattern.
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

    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func estimate(itemId: String) async throws -> Response {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/flipdesk/ai/size"
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build URL")
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = await SupabaseShared.currentAccessToken() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            req.httpBody = try JSONEncoder().encode(Request(itemId: itemId))
        } catch {
            throw EdgeAPIError.decoding(
                "Encoding size request failed: \(error.localizedDescription)")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw EdgeAPIError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw EdgeAPIError.network("Non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw EdgeAPIError.from(statusCode: http.statusCode, body: data)
        }

        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }
}
