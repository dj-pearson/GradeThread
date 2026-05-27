import Foundation
import Observation

/// State machine for the reconciliation view. Holds the live orphan
/// list + a bulk-action result for the toast.
@MainActor
@Observable
public final class ReconciliationStore {
    public enum Phase: Equatable {
        case loading
        case ready(orphans: [OrphanEbayListing])
        case failed(message: String)
    }

    public var phase: Phase = .loading
    public var lastBulkResult: ReconciliationBulkResult?
    public var isWorking: Bool = false

    private let service: ReconciliationService

    public init(service: ReconciliationService = ReconciliationService()) {
        self.service = service
    }

    // MARK: - Reads

    public var orphans: [OrphanEbayListing] {
        if case let .ready(orphans) = phase { return orphans }
        return []
    }

    public var count: Int { orphans.count }

    // MARK: - Lifecycle

    public func refresh(userId: String) async {
        phase = .loading
        do {
            let rows = try await service.fetchOrphans(userId: userId)
            phase = .ready(orphans: rows)
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    // MARK: - Actions

    /// Optimistically remove the orphan from the list while the action
    /// is in flight. If the network call fails we re-add it so the
    /// user can retry.
    public func runAction(
        on orphan: OrphanEbayListing,
        action: @escaping (OrphanEbayListing) async -> ReconciliationOutcome
    ) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }

        // Optimistic removal.
        let snapshot = orphans
        replaceOrphans(orphans.filter { $0.id != orphan.id })

        let outcome = await action(orphan)
        if !outcome.isSuccess {
            // Restore the row so the user can try again.
            replaceOrphans(snapshot)
            phase = .failed(message: errorMessage(from: outcome) ?? "Action failed.")
        }
    }

    /// Bulk create — best-effort across the whole list. Successful rows
    /// drop out of the queue; failed rows stay.
    public func runCreateAll(
        userId: String,
        service: ReconciliationService
    ) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }

        let snapshot = orphans
        guard !snapshot.isEmpty else { return }
        let result = await service.createAll(snapshot, userId: userId)
        lastBulkResult = result

        // Remove the ones that succeeded — anything in `failures` stays.
        let failedIds = Set(result.failures.map(\.orphanId))
        replaceOrphans(snapshot.filter { failedIds.contains($0.id) })
    }

    // MARK: - Internals

    private func replaceOrphans(_ new: [OrphanEbayListing]) {
        phase = .ready(orphans: new)
    }

    private func errorMessage(from outcome: ReconciliationOutcome) -> String? {
        if case .failed(let message) = outcome.kind { return message }
        return nil
    }
}
