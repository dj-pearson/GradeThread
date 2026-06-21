import Foundation

/// Calls `POST /api/grade/snap` — the free, signup-gated Snap-to-Value scan.
/// Mirrors ``AIExtractService``'s self-contained pattern (manual `URLRequest`
/// + Supabase bearer token + ``EdgeAPIError`` mapping). The image is sent as a
/// base64 data-URI; the edge validates + EXIF-strips it before grading and
/// never stores it.
@MainActor
final class SnapService {

    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    private struct SnapRequest: Encodable {
        let image: String
        let brand: String?
        let keyword: String?
    }

    func snap(imageData: Data, brand: String?, keyword: String?) async throws -> SnapResponse {
        // US-1164: guard instead of force-unwrapping a malformed base URL.
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw EdgeAPIError.network("Could not build URL")
        }
        components.path = "/api/grade/snap"
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
            // US-1165: base64-encode the (large) JPEG and JSON-encode the body off
            // the main actor — this service is @MainActor, so doing it inline would
            // block the UI on a big image.
            req.httpBody = try await Task.detached(priority: .userInitiated) {
                let dataURI = "data:image/jpeg;base64," + imageData.base64EncodedString()
                let body = SnapRequest(
                    image: dataURI,
                    brand: (brand?.isEmpty == false) ? brand : nil,
                    keyword: (keyword?.isEmpty == false) ? keyword : nil
                )
                return try JSONEncoder().encode(body)
            }.value
        } catch {
            throw EdgeAPIError.decoding("Encoding snap request failed: \(error.localizedDescription)")
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

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(SnapResponse.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }
}
