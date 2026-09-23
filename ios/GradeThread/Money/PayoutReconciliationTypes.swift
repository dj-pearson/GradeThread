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

// `PayoutDateFormat` moved to GradeThreadCore (PayoutDateFormat.swift) so its
// date-only vs instant rule is asserted by `swift test` on Linux.
