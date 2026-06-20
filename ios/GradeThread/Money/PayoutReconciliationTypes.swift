import Foundation

// US-666 — payout reconciliation wire models. Mirrors the edge route
// `routes/flipdesk-reconciliation.ts` (GET /queue, POST /run, POST /match,
// POST /dismiss/:id). This is DISTINCT from the orphan-listing reconciliation
// in `Marketplaces/Reconciliation/` (which links eBay listings to inventory);
// this matches eBay *payouts* to *sales* so the books reconcile.
//
// Responses go through EdgeAPI's `.convertFromSnakeCase` + `.iso8601` decoder,
// so structs use camelCase with no CodingKeys. Date columns arrive as date-only
// strings (`YYYY-MM-DD`) which the strict ISO-8601 date strategy can't parse —
// so timestamps stay `String?` and are parsed leniently for display.

/// One candidate sale the server scored against a payout.
struct PayoutCandidate: Decodable, Identifiable, Equatable {
    let saleId: String
    let itemId: String
    let itemTitle: String?
    let saleDate: String?
    let salePrice: Double?
    let payoutAmount: Double?
    let payoutReference: String?
    let score: Double
    let reasons: [String]

    var id: String { saleId }

    /// 0–100 confidence for display.
    var scorePercent: Int { Int((min(max(score, 0), 1) * 100).rounded()) }
}

/// The payout side of a queue entry.
struct PayoutImportSummary: Decodable, Equatable {
    let id: String
    let payoutDate: String?
    let amount: Double?
    let createdAt: String?
}

/// One unreconciled payout plus up to five candidate sales.
struct PayoutQueueEntry: Decodable, Identifiable, Equatable {
    let payoutImport: PayoutImportSummary
    let candidates: [PayoutCandidate]

    var id: String { payoutImport.id }

    /// Best candidate (server already sorts desc, but be defensive).
    var topCandidate: PayoutCandidate? {
        candidates.max { $0.score < $1.score }
    }
}

/// GET /queue envelope.
struct PayoutQueueResponse: Decodable, Equatable {
    let queue: [PayoutQueueEntry]
}

/// POST /run summary counts.
struct PayoutRunResult: Decodable, Equatable {
    let autoMatched: Int
    let ambiguous: Int
    let noCandidates: Int
    let scanned: Int
}

/// POST /match success.
struct PayoutMatchResult: Decodable, Equatable {
    let ok: Bool
    let payoutImportId: String?
    let saleId: String?
}

/// POST /dismiss/:id success.
struct PayoutDismissResult: Decodable, Equatable {
    let ok: Bool
}

/// POST /api/flipdesk/ebay/payouts/import-csv summary counts (US-817). Mirrors
/// the web `ImportPayoutsCsvResponse`. The iOS importer posts the raw CSV to the
/// SAME edge endpoint the web Reconciliation page uses, so parsing/dedup never
/// diverges between platforms — the device only reads the file and uploads its
/// text.
struct PayoutImportResult: Decodable, Equatable {
    let imported: Int
    let skipped: Int
    let duplicates: Int
}

// MARK: - Display helpers

enum PayoutDateFormat {
    /// Parses a date-only (`YYYY-MM-DD`) or full ISO-8601 string.
    static func parse(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let full = ISO8601DateFormatter()
        full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = full.date(from: raw) { return d }
        if let d = ISO8601DateFormatter().date(from: raw) { return d }
        let dateOnly = DateFormatter()
        dateOnly.locale = Locale(identifier: "en_US_POSIX")
        dateOnly.timeZone = TimeZone(identifier: "UTC")
        dateOnly.dateFormat = "yyyy-MM-dd"
        return dateOnly.date(from: raw)
    }

    /// Short medium-style display ("Jan 5, 2024"), or "—".
    static func display(_ raw: String?) -> String {
        guard let date = parse(raw) else { return "—" }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        return f.string(from: date)
    }
}
