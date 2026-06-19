import Foundation

/// Coalesces a burst of `trigger()` calls into a single trailing execution of
/// `action`, firing at most once per `window` (US-997).
///
/// The ``SyncEngine`` connectivity loop runs `flushPending()` + `pull()` on
/// every `connected == true` event from ``NetworkMonitor``. Walking between
/// Wi-Fi and cell can flap connectivity several times per second, and each flap
/// otherwise kicked a full flush + (potentially full-table) pull — draining
/// battery and cellular data. Routing those events through this debouncer
/// collapses a flap storm into one sync once the link settles.
///
/// Trailing semantics: every `trigger()` (re)starts the window, so a continuous
/// burst keeps deferring until it quiets, then fires exactly once. Manual
/// pull-to-refresh deliberately does NOT go through here — it calls the engine
/// directly so a user gesture stays immediate.
///
/// An actor so its scheduling state never races with the connectivity loop.
/// `sleep` is injectable purely so tests can drive the window deterministically.
actor ConnectivityDebouncer {
    private let window: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    private let action: @Sendable () async -> Void
    private var pendingTask: Task<Void, Never>?

    init(
        window: Duration,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        action: @escaping @Sendable () async -> Void
    ) {
        self.window = window
        self.sleep = sleep
        self.action = action
    }

    /// Schedule `action`. A trigger arriving before the window elapses cancels
    /// the still-pending run and restarts the window, so a burst collapses into
    /// a single trailing execution.
    func trigger() {
        pendingTask?.cancel()
        pendingTask = Task { [window, sleep, action] in
            do {
                try await sleep(window)
            } catch {
                return  // superseded by a newer trigger (or cancelled)
            }
            if Task.isCancelled { return }
            await action()
        }
    }

    /// Drop any pending run without firing (e.g. on disconnect / shutdown).
    func cancel() {
        pendingTask?.cancel()
        pendingTask = nil
    }
}
