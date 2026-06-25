import Foundation
import SwiftData

/// Background ``ModelActor`` that owns the offline-mutation queue's SwiftData
/// reads/writes off the main actor (US-1165).
///
/// `SyncEngine` previously wrapped every pending-mutation touch
/// (snapshot / dequeue / failure + stuck bookkeeping / counts) in
/// `await MainActor.run { ModelContext(container) … }`, so draining a large
/// queue serialized a burst of fetch/save work onto the main thread and could
/// hitch the UI. This actor mirrors ``SyncMergeActor``: a single private
/// ``ModelContext`` created once by the `@ModelActor` macro and reused across
/// calls, running entirely on the actor's background executor. The engine only
/// hops to ``MainActor`` to publish the resulting status counts to
/// ``SyncStatusStore``.
///
/// SwiftData `@Model` rows are not `Sendable`, so this actor never returns a
/// `LocalPendingMutation` across its isolation boundary — callers read back only
/// the `Sendable` ``SyncEngine/PendingMutationSnapshot`` value snapshots.
@ModelActor
actor PendingMutationActor {

    /// Snapshot the full queue (FIFO drain order) for the inspector + flush loop.
    func snapshot() -> [SyncEngine.PendingMutationSnapshot] {
        let descriptor = FetchDescriptor<LocalPendingMutation>(
            sortBy: [SortDescriptor(\.createdAt)]
        )
        let rows = (try? modelContext.fetch(descriptor)) ?? []
        return rows.map {
            SyncEngine.PendingMutationSnapshot(
                id: $0.id,
                kind: $0.kind,
                payload: $0.payload,
                targetId: $0.targetId,
                retryCount: $0.retryCount,
                lastError: $0.lastError,
                lastAttemptAt: $0.lastAttemptAt,
                createdAt: $0.createdAt
            )
        }
    }

    /// Server-confirmed → dequeue.
    func delete(id: String) {
        guard let row = fetchOne(id: id) else { return }
        modelContext.delete(row)
        modelContext.saveOrLog("deleteMutation")
    }

    /// Records a retryable replay failure: bumps `retryCount`, stamps
    /// `lastError`/`lastAttemptAt`, and breadcrumbs the attempt (flagging the
    /// transition to "stuck" once the budget is exhausted). Runs off-main —
    /// ``Telemetry/backgroundBreadcrumb(_:category:)`` is `nonisolated`.
    func markFailed(id: String, error: String, maxRetries: Int) {
        guard let row = fetchOne(id: id) else { return }
        row.retryCount += 1
        row.lastError = error
        row.lastAttemptAt = .now
        // US-1148: breadcrumb every replay failure (scrubbed by Sentry's
        // beforeBreadcrumb); flag the transition to "stuck" (US-1147)
        // distinctly since that one needs manual user attention.
        let stuckSuffix = row.retryCount >= maxRetries ? " — now stuck (manual retry needed)" : ""
        Telemetry.backgroundBreadcrumb(
            "Mutation replay failed (kind \(row.kind), attempt \(row.retryCount)/\(maxRetries)): \(error)\(stuckSuffix)",
            category: "sync")
        modelContext.saveOrLog("markFailed")
    }

    /// US-1221: flag a mutation as stuck (needs manual retry/discard) without
    /// stepping through the transient-retry budget — used for terminal replay
    /// errors that can never succeed. Pins `retryCount` to `maxRetries` so the
    /// flush loop skips it and ``stuckCount(maxRetries:)`` surfaces it.
    func markStuck(id: String, error: String, maxRetries: Int) {
        guard let row = fetchOne(id: id) else { return }
        row.retryCount = maxRetries
        row.lastError = error
        row.lastAttemptAt = .now
        Telemetry.backgroundBreadcrumb(
            "Mutation replay terminal (kind \(row.kind)): \(error) — now stuck (manual retry needed)",
            category: "sync")
        modelContext.saveOrLog("markStuck")
    }

    /// Clears a mutation's error + retry budget so a user-initiated retry
    /// (US-641) re-attempts it from scratch.
    func clearErrorAndResetRetry(id: String) {
        guard let row = fetchOne(id: id) else { return }
        row.lastError = nil
        row.retryCount = 0
        modelContext.saveOrLog("retryMutation")
    }

    func pendingCount() -> Int {
        (try? modelContext.fetchCount(FetchDescriptor<LocalPendingMutation>())) ?? 0
    }

    /// Count of mutations that have exhausted their auto-retry budget and now
    /// need the user's attention (US-1147). `#Predicate` can't reference a type
    /// member, so the ceiling is captured locally.
    func stuckCount(maxRetries: Int) -> Int {
        let ceiling = maxRetries
        let descriptor = FetchDescriptor<LocalPendingMutation>(
            predicate: #Predicate { $0.retryCount >= ceiling })
        return (try? modelContext.fetchCount(descriptor)) ?? 0
    }

    private func fetchOne(id: String) -> LocalPendingMutation? {
        let descriptor = FetchDescriptor<LocalPendingMutation>(predicate: #Predicate { $0.id == id })
        return try? modelContext.fetch(descriptor).first
    }
}
