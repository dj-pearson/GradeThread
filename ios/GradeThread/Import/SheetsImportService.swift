import Foundation

/// US-667 — fetches a public Google Sheet as CSV via the edge (`/sheets/
/// fetch-csv`). The edge validates the docs.google.com URL + rebuilds the
/// export URL server-side (SSRF guard), so iOS never fetches Google directly.
protocol SheetsImporting {
    func fetchCSV(url: String) async throws -> String
}

struct SheetsImportService: SheetsImporting {
    private let api: EdgeAPI
    init(api: EdgeAPI = .shared) { self.api = api }

    func fetchCSV(url: String) async throws -> String {
        struct Body: Encodable { let url: String }
        struct Response: Decodable { let csv: String }
        let res: Response = try await api.postJSON("/api/flipdesk/sheets/fetch-csv", body: Body(url: url))
        return res.csv
    }
}
