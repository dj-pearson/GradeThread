import SwiftUI

/// Makes the long-lived ``SyncEngine`` reachable from leaf views (notably the
/// ``SyncStatusBar`` → ``PendingChangesView`` inspector, US-641) without
/// threading a handle through every initializer. ContentView injects the engine
/// when it boots one on sign-in; views read it via `@Environment(\.syncEngine)`.
private struct SyncEngineKey: EnvironmentKey {
    static let defaultValue: SyncEngine? = nil
}

extension EnvironmentValues {
    var syncEngine: SyncEngine? {
        get { self[SyncEngineKey.self] }
        set { self[SyncEngineKey.self] = newValue }
    }
}
