import Foundation

/// Edge client for payout reconciliation (US-666). All four endpoints are
/// tenant-scoped server-side (the edge resolves `workspaceOwnerId ?? userId`),
/// so no ids from the device are trusted for ownership. Behind a protocol so
/// ``PayoutReconciliationStore`` is unit-testable with a fake.
protocol PayoutReconciliationProviding {
    func queue() async throws -> [PayoutQueueEntry]
    func run() async throws -> PayoutRunResult
    func match(payoutImportId: String, saleId: String) async throws
    func dismiss(payoutImportId: String) async throws
    /// US-817: upload an eBay payouts CSV's raw text to the shared edge importer.
    func importCsv(_ csv: String) async throws -> PayoutImportResult
}

struct PayoutReconciliationService: PayoutReconciliationProviding {
    private let api: EdgeAPI
    init(api: EdgeAPI = .shared) { self.api = api }

    func queue() async throws -> [PayoutQueueEntry] {
        let res: PayoutQueueResponse = try await api.getJSON("/api/flipdesk/reconciliation/queue")
        return res.queue
    }

    func run() async throws -> PayoutRunResult {
        struct Empty: Encodable {}
        return try await api.postJSON("/api/flipdesk/reconciliation/run", body: Empty())
    }

    func match(payoutImportId: String, saleId: String) async throws {
        struct Body: Encodable { let payoutImportId: String; let saleId: String }
        let _: PayoutMatchResult = try await api.postJSON(
            "/api/flipdesk/reconciliation/match",
            body: Body(payoutImportId: payoutImportId, saleId: saleId))
    }

    func dismiss(payoutImportId: String) async throws {
        struct Empty: Encodable {}
        let _: PayoutDismissResult = try await api.postJSON(
            "/api/flipdesk/reconciliation/dismiss/\(payoutImportId)", body: Empty())
    }

    func importCsv(_ csv: String) async throws -> PayoutImportResult {
        // US-817: same endpoint + body shape the web uses (see use-payouts.ts).
        // Server-side parse/dedup keeps both clients in lockstep — a 400 carries
        // an actionable message (e.g. "Could not find a payouts table…").
        struct Body: Encodable { let csv: String }
        return try await api.postJSON(
            "/api/flipdesk/ebay/payouts/import-csv", body: Body(csv: csv))
    }
}
