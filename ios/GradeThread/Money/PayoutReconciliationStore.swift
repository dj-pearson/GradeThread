import SwiftUI

/// View-model for payout reconciliation (US-666). Loads the unreconciled-payout
/// queue, runs the server auto-match sweep, and applies/dismisses individual
/// payouts. Mirrors the other `@MainActor @Observable` stores.
@MainActor
@Observable
final class PayoutReconciliationStore {

    enum Phase: Equatable {
        case idle
        case loading
        case ready
        case failed(String)
    }

    private let service: PayoutReconciliationProviding

    var phase: Phase = .idle
    private(set) var entries: [PayoutQueueEntry] = []

    /// Set after a `/run` sweep so the UI can surface the result banner.
    var lastRun: PayoutRunResult?
    var isRunning = false

    /// Row-level error surfaced from match/dismiss (e.g. a 409 conflict).
    var actionError: String?
    /// payout ids currently mid-action (disables their buttons + shows a spinner).
    private(set) var busyIds: Set<String> = []

    init(service: PayoutReconciliationProviding = PayoutReconciliationService()) {
        self.service = service
    }

    var unreconciledCount: Int { entries.count }

    func load() async {
        if entries.isEmpty { phase = .loading }
        do {
            entries = try await service.queue()
            phase = .ready
        } catch {
            phase = .failed(message(error))
        }
    }

    /// Server sweep that auto-matches unambiguous payouts, then reloads.
    func runAutoMatch() async {
        isRunning = true
        defer { isRunning = false }
        do {
            lastRun = try await service.run()
            await load()
        } catch {
            actionError = message(error)
        }
    }

    func match(_ entry: PayoutQueueEntry, to candidate: PayoutCandidate) async {
        let id = entry.payoutImport.id
        busyIds.insert(id)
        defer { busyIds.remove(id) }
        do {
            try await service.match(payoutImportId: id, saleId: candidate.saleId)
            entries.removeAll { $0.id == id }
        } catch {
            actionError = message(error)
        }
    }

    func dismiss(_ entry: PayoutQueueEntry) async {
        let id = entry.payoutImport.id
        busyIds.insert(id)
        defer { busyIds.remove(id) }
        do {
            try await service.dismiss(payoutImportId: id)
            entries.removeAll { $0.id == id }
        } catch {
            actionError = message(error)
        }
    }

    func isBusy(_ entry: PayoutQueueEntry) -> Bool { busyIds.contains(entry.payoutImport.id) }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
