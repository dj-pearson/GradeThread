import Foundation
import Observation

/// Drives the sync modal. Owns the phase machine and the rotating
/// stage-label timer so the modal doesn't have to manage timer state.
@MainActor
@Observable
public final class EbaySyncStore {
    /// Display stages cycled while polling. The actual server work runs
    /// detached so we can't tie these to real progress events — they're
    /// time-driven UX so the wait doesn't feel stuck.
    public static let stages: [String] = [
        "Loading listings…",
        "Matching SKUs…",
        "Pulling orders + fees…",
    ]

    public enum Phase: Equatable {
        case idle
        case starting
        case syncing(stageIndex: Int)
        case completed(EbaySyncSummary)
        case timedOut
        case connectionFlagged(message: String)
        case failed(message: String)
    }

    public var phase: Phase = .idle

    private var stageTimer: Task<Void, Never>?

    public init() {}

    // MARK: - Lifecycle

    public func beginSync() {
        phase = .starting
        startStageTimer()
    }

    public func apply(_ completion: EbaySyncCompletion) {
        switch completion {
        case .completed(let summary):     phase = .completed(summary)
        case .timedOut:                   phase = .timedOut
        case .connectionFlagged(let msg): phase = .connectionFlagged(message: msg)
        case .failed(let msg):            phase = .failed(message: msg)
        }
        stageTimer?.cancel()
        stageTimer = nil
    }

    public func reset() {
        phase = .idle
        stageTimer?.cancel()
        stageTimer = nil
    }

    // MARK: - Stage rotation

    /// Cycles through ``stages`` every `interval` seconds while the sync
    /// is in flight. Stops on apply()/reset().
    private func startStageTimer(interval: TimeInterval = 5) {
        stageTimer?.cancel()
        phase = .syncing(stageIndex: 0)
        stageTimer = Task { [weak self] in
            var idx = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                if Task.isCancelled { return }
                idx = (idx + 1) % Self.stages.count
                await MainActor.run {
                    guard let self else { return }
                    // Only advance if still in a syncing phase — applying
                    // a completion before the next tick should win.
                    if case .syncing = self.phase {
                        self.phase = .syncing(stageIndex: idx)
                    }
                }
            }
        }
    }
}

extension EbaySyncStore.Phase {
    /// Convenience for views to read the rotating label without
    /// unwrapping the enum case manually.
    var stageLabel: String? {
        if case .syncing(let idx) = self {
            return EbaySyncStore.stages[idx]
        }
        if case .starting = self {
            return EbaySyncStore.stages.first
        }
        return nil
    }
}
