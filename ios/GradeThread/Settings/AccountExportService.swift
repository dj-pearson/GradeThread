import Foundation

/// Fetches the user's data export from the edge (`GET /api/account/export`).
/// The endpoint returns a JSON document (profile + submissions + grades +
/// inventory + listings + sales + sources) as a downloadable attachment;
/// the caller writes it to a temp file and hands it to a share sheet.
@MainActor
struct AccountExportService {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = AppConfig.edgeAPIURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    /// Returns the raw export JSON bytes. Throws ``EdgeAPIError`` on failure.
    func export() async throws -> Data {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/account/export"
        guard let url = components.url else {
            throw EdgeAPIError.network("Could not build export URL")
        }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
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
            throw EdgeAPIError.from(statusCode: http.statusCode, body: data)
        }
        return data
    }

    /// Writes export bytes to a temp file the share sheet can hand off.
    func writeTempFile(_ data: Data) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("gradethread-export.json")
        try data.write(to: url, options: [.atomic])
        return url
    }
}
