import Foundation
import Network

/// Observable wrapper around `NWPathMonitor`. Exposes `isConnected` for
/// UI bindings and an `AsyncStream<Bool>` so the ``SyncEngine`` can react
/// to connectivity changes without polling.
@MainActor
@Observable
public final class NetworkMonitor {
    public private(set) var isConnected: Bool = true

    private let pathMonitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.gradethread.network-monitor")
    private var continuations: [UUID: AsyncStream<Bool>.Continuation] = [:]

    public init() {}

    public func start() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let connected = path.status == .satisfied
            Task { @MainActor in
                self?.updateConnectivity(connected)
            }
        }
        pathMonitor.start(queue: queue)
    }

    public func stop() {
        pathMonitor.cancel()
        for continuation in continuations.values {
            continuation.finish()
        }
        continuations.removeAll()
    }

    /// Stream of connectivity changes. Each subscriber gets the current
    /// value as the first event so it can render an initial state without
    /// waiting for the next change.
    public func connectivityStream() -> AsyncStream<Bool> {
        AsyncStream { continuation in
            let id = UUID()
            self.continuations[id] = continuation
            continuation.yield(self.isConnected)
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in
                    self?.continuations.removeValue(forKey: id)
                }
            }
        }
    }

    private func updateConnectivity(_ connected: Bool) {
        guard connected != isConnected else { return }
        isConnected = connected
        for continuation in continuations.values {
            continuation.yield(connected)
        }
    }
}
