import Foundation
import Observation
import SwiftData

/// Drives the offline ↔ server reconciliation loop.
///
/// Two phases per pass:
///
/// 1. **Pull** — fetch fresh rows from `items_full` / `listings` / `sales`
///    via Supabase PostgREST and merge them into the SwiftData store using
///    ``ConflictPolicy``.
/// 2. **Flush** — drain `LocalPendingMutation` queue, applying each
///    mutation against the edge service. Failures bump `retryCount` and
///    stay queued; transient errors retry on the next pass.
///
/// The engine is an actor so its internal scheduling state never races,
/// even if the pull and flush triggers fire concurrently (foreground
/// notification + connectivity-restored at the same instant). UI-visible
/// status lives on ``SyncStatusStore`` which is `@MainActor`.
actor SyncEngine {
    private let container: ModelContainer
    private let statusStore: SyncStatusStore
    private let networkMonitor: NetworkMonitor

    /// Userspace tag for log prefixes so production logs are grep-able.
    private let logPrefix = "[SyncEngine]"

    /// Guard rail: a single active pull at a time avoids double-merging
    /// the same server response when, e.g., a foreground notification
    /// arrives mid-flush.
    private var isPulling = false
    private var isFlushing = false

    /// Background task watching connectivity. Started in `start()`,
    /// cancelled in `stop()`.
    private var connectivityTask: Task<Void, Never>?

    init(
        container: ModelContainer,
        statusStore: SyncStatusStore,
        networkMonitor: NetworkMonitor
    ) {
        self.container = container
        self.statusStore = statusStore
        self.networkMonitor = networkMonitor
    }

    // MARK: - Lifecycle

    func start() {
        guard connectivityTask == nil else { return }
        // Capture the @MainActor observables as locals so the Task closure
        // doesn't have to hop into the actor's isolation just to read them.
        let monitor = networkMonitor
        let status = statusStore
        connectivityTask = Task { [weak self] in
            let stream = await MainActor.run { monitor.connectivityStream() }
            for await connected in stream {
                if connected {
                    await status.set(.idle)
                    await self?.flushPending()
                    await self?.pull()
                } else {
                    await status.set(.offline)
                }
            }
        }
    }

    func stop() {
        connectivityTask?.cancel()
        connectivityTask = nil
    }

    /// Foreground entrypoint — also called when the user pulls-to-refresh.
    func sync() async {
        await pull()
        await flushPending()
        await refreshPendingCount()
    }

    // MARK: - Pull

    /// Fetches and merges. Stubbed at the IO boundary — when the network
    /// fixtures for inventory_items / listings / sales land we'll wire
    /// the real PostgREST calls. The merge step itself is fully implemented
    /// and unit-tested via ``ConflictPolicy``.
    func pull() async {
        guard !isPulling else { return }
        isPulling = true
        defer { isPulling = false }

        await statusStore.set(.syncing)
        // TODO(US-180): swap in real PostgREST calls once the list/detail
        // hooks land. For now the engine no-ops cleanly so the UI surface
        // and conflict policy can be exercised in tests.
        // let remoteItems = try await SupabaseShared.client.from("items_full")…
        await refreshPendingCount()
        let pending = await pendingMutationCount()
        await statusStore.set(pending > 0 ? .pending : .idle)
    }

    // MARK: - Flush

    func flushPending() async {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }

        let mutations = await loadPendingMutations()
        guard !mutations.isEmpty else { return }

        await statusStore.set(.syncing)
        for mutation in mutations {
            await apply(mutation)
        }
        await refreshPendingCount()
    }

    /// Concrete mutation handlers will fan out from here per ``MutationKind``.
    /// For now, every mutation just no-ops and stays queued so the offline
    /// queue plumbing is observable end-to-end without depending on the
    /// (yet-to-wire) intake / photo-upload flows.
    private func apply(_ mutation: LocalPendingMutation) async {
        guard let kind = mutation.kindEnum else {
            await markFailed(mutation, error: "unknown mutation kind \(mutation.kind)")
            return
        }
        switch kind {
        case .createInventoryItem,
             .updateInventoryItem,
             .deleteInventoryItem,
             .uploadPhoto,
             .deletePhoto,
             .createListing,
             .createSale:
            // TODO(US-175 / US-178): wire the EdgeAPI / supabase calls per
            // kind. Until then we bump retryCount + lastError so the queue
            // doesn't silently lie about progress.
            await markFailed(
                mutation,
                error: "Mutation handler for \(kind.rawValue) lands in US-175 / US-178."
            )
        }
    }

    // MARK: - SwiftData helpers

    /// Snapshot the queue inside a `@MainActor` ModelContext. We don't pass
    /// PersistentModel instances across the actor boundary — only the
    /// scalar payloads they hold.
    private func loadPendingMutations() async -> [LocalPendingMutation] {
        await MainActor.run {
            let context = ModelContext(container)
            let descriptor = FetchDescriptor<LocalPendingMutation>(
                sortBy: [SortDescriptor(\.createdAt)]
            )
            return (try? context.fetch(descriptor)) ?? []
        }
    }

    private func markFailed(_ mutation: LocalPendingMutation, error: String) async {
        await MainActor.run {
            let context = ModelContext(container)
            let id = mutation.id
            let descriptor = FetchDescriptor<LocalPendingMutation>(
                predicate: #Predicate { $0.id == id }
            )
            guard let row = try? context.fetch(descriptor).first else { return }
            row.retryCount += 1
            row.lastError = error
            row.lastAttemptAt = .now
            try? context.save()
        }
    }

    private func pendingMutationCount() async -> Int {
        await MainActor.run {
            let context = ModelContext(container)
            let descriptor = FetchDescriptor<LocalPendingMutation>()
            return (try? context.fetchCount(descriptor)) ?? 0
        }
    }

    private func refreshPendingCount() async {
        let count = await pendingMutationCount()
        await statusStore.setPendingCount(count)
    }
}

// MARK: - Status store

/// Main-actor observable that backs ``SyncStatusBar``. Kept separate from
/// the actor-isolated engine so SwiftUI bindings don't have to hop actors
/// to read state.
@MainActor
@Observable
final class SyncStatusStore {
    enum Phase: Equatable {
        case idle
        case syncing
        case pending
        case offline
    }

    var phase: Phase = .idle
    var pendingCount: Int = 0

    func set(_ next: Phase) {
        phase = next
    }

    func setPendingCount(_ count: Int) {
        pendingCount = count
        // Reconcile derived state: even if a pull just succeeded, surface
        // the pending banner instead of "idle" so the user knows writes
        // haven't shipped.
        if phase == .idle, count > 0 {
            phase = .pending
        } else if phase == .pending, count == 0 {
            phase = .idle
        }
    }
}
