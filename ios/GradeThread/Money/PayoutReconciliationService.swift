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
}
