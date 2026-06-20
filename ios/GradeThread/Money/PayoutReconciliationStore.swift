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
    /// Transient success confirmation (e.g. after a CSV import) shown as a
    /// brandNavy capsule — mirrors the FlipDesk store convention.
    var actionBanner: String?
    /// Set after a CSV import so the UI can surface imported/duplicate counts.
    var lastImport: PayoutImportResult?
    /// True while a payout CSV is uploading (disables the import button).
    var isImporting = false
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

    /// US-817: upload a payout CSV's text through the shared edge importer, then
    /// reload so the freshly-imported unreconciled rows appear in the review
    /// queue. A bad/wrong-columns CSV comes back as an actionable error string.
    func importCsv(_ csv: String) async {
        let trimmed = csv.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            actionError = "That file looks empty. Export the report from eBay Seller Hub → Payments → Payouts → Download."
            return
        }
        isImporting = true
        defer { isImporting = false }
        do {
            let result = try await service.importCsv(csv)
            lastImport = result
            actionBanner = Self.importSummary(result)
            // New rows land unreconciled — reload so they show in the queue.
            await load()
        } catch {
            actionError = message(error)
        }
    }

    /// Human summary of an import: imported count plus duplicate/skipped notes.
    /// `nonisolated` (it's a pure function of its argument) so it stays callable
    /// from the synchronous, non-MainActor unit tests despite the enclosing
    /// `@MainActor` store.
    nonisolated static func importSummary(_ r: PayoutImportResult) -> String {
        var parts = ["Imported \(r.imported) payout\(r.imported == 1 ? "" : "s")"]
        if r.duplicates > 0 {
            parts.append("\(r.duplicates) duplicate\(r.duplicates == 1 ? "" : "s") skipped")
        }
        if r.skipped > 0 {
            parts.append("\(r.skipped) row\(r.skipped == 1 ? "" : "s") skipped")
        }
        return parts.joined(separator: " · ")
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
