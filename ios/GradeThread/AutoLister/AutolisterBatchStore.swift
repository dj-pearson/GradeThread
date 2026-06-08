import SwiftUI

/// View-model for an AutoLister generation batch. Owns the batch lifecycle:
/// submit a set of item ids, poll per-job status until terminal, retry failures,
/// and surface photo-QA nudges. The photos → items → upload → classify pipeline
/// that produces the `itemIds` is layered on in a later phase; `submit(itemIds:)`
/// is the seam it calls.
///
/// Pattern mirrors `ScoutStore`: `@MainActor ObservableObject`, an injected
/// service protocol for tests, and pure-ish `apply`/`pollOnce` steps so the
/// poll/terminalize logic is unit-tested without a network or real timers.
@MainActor
final class AutolisterBatchStore: ObservableObject {

    enum Phase: Equatable {
        case idle
        case submitting
        case running          // batch created; polling per-job status
        case completed        // all jobs succeeded
        case partial          // some succeeded, some failed
        case failed(String)   // batch failed outright / submit error
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var batch: AutolisterBatch?
    @Published private(set) var jobs: [AutolisterJob] = []
    /// Photo-QA results keyed by inventory_item_id (US-537 nudges).
    @Published private(set) var photoQa: [String: PhotoQaResult] = [:]
    @Published private(set) var errorMessage: String?

    private let service: AutolisterBatching
    /// Poll cadence while a batch is running. The GET status route is rate-limited
    /// at 120/min, so 1.5s (~40/min) is comfortable. Injectable for tests.
    private let pollIntervalNanos: UInt64
    private var pollTask: Task<Void, Never>?
    private(set) var batchId: String?

    init(
        service: AutolisterBatching = AutolisterService(),
        pollIntervalNanos: UInt64 = 1_500_000_000
    ) {
        self.service = service
        self.pollIntervalNanos = pollIntervalNanos
    }

    // MARK: - Derived

    /// Finished jobs (success or failed) over total — drives the progress bar.
    var progress: Double {
        guard let batch, batch.itemCount > 0 else { return 0 }
        let done = batch.succeededCount + batch.failedCount
        return min(1, Double(done) / Double(batch.itemCount))
    }

    var isTerminal: Bool {
        switch phase {
        case .completed, .partial, .failed: return true
        case .idle, .submitting, .running: return false
        }
    }

    var hasFailures: Bool { jobs.contains { $0.status == .failed } }

    // MARK: - Lifecycle

    /// Submit already-created, already-uploaded items for generation, then start
    /// polling. Returns once the batch is created (polling continues in the
    /// background); call sites observe `phase`/`jobs` for progress.
    func submit(itemIds: [String], useComps: Bool = true, templateId: String? = nil) async {
        guard !itemIds.isEmpty else { return }
        phase = .submitting
        errorMessage = nil
        do {
            let res = try await service.startBatch(itemIds: itemIds, useComps: useComps, templateId: templateId)
            batchId = res.batchId
            phase = .running
            startPolling()
        } catch {
            phase = .failed(message(error))
            errorMessage = message(error)
        }
    }

    /// Re-run only the failed jobs in the current batch, in place.
    func retryFailed() async {
        guard let batchId else { return }
        errorMessage = nil
        do {
            _ = try await service.retryFailed(batchId: batchId)
            phase = .running
            startPolling()
        } catch {
            errorMessage = message(error)
        }
    }

    /// Score the given items' photos for listing-readiness (non-fatal; results
    /// land in `photoQa` for the queue to surface as reshoot nudges).
    func runPhotoQa(itemIds: [String]) async {
        guard !itemIds.isEmpty else { return }
        do {
            let res = try await service.photoQa(itemIds: itemIds)
            for result in res.results { photoQa[result.itemId] = result }
        } catch {
            errorMessage = message(error)
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func reset() {
        stop()
        phase = .idle
        batch = nil
        jobs = []
        photoQa = [:]
        errorMessage = nil
        batchId = nil
    }

    // MARK: - Polling

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if await self.pollOnce() { break }
                try? await Task.sleep(nanoseconds: self.pollIntervalNanos)
            }
        }
    }

    /// One status fetch + apply. Returns true when the batch reached a terminal
    /// state (caller stops the loop). A transient fetch error is non-fatal:
    /// surfaced in `errorMessage`, returns false so polling continues.
    @discardableResult
    func pollOnce() async -> Bool {
        guard let batchId else { return true }
        do {
            let res = try await service.batchStatus(batchId: batchId)
            apply(res)
            return res.batch.status.isTerminal
        } catch {
            errorMessage = message(error)
            return false
        }
    }

    /// PURE: fold a status response into published state + derived phase.
    func apply(_ res: BatchStatusResponse) {
        batch = res.batch
        jobs = res.jobs
        switch res.batch.status {
        case .pending, .running:
            phase = .running
        case .completed:
            phase = .completed
        case .partial:
            phase = .partial
        case .failed:
            phase = .failed(res.batch.error ?? "Generation failed.")
        }
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
