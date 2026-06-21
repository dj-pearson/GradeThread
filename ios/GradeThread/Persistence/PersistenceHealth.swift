import Foundation

/// Makes local SwiftData write failures observable instead of silently
/// swallowed (US-1142).
///
/// The offline cache used to scatter `try? context.save()` across the sync,
/// upload, and editing surfaces — a failed save (disk full, store corruption,
/// truncated write under pressure) vanished with no breadcrumb and no user
/// signal, so the UI showed edits that were never persisted. ``ModelContext``'s
/// `saveOrLog(_:)` now routes every failure here, which:
///
///   1. records a scrubbed Sentry breadcrumb (always — diagnostics), and
///   2. posts a main-thread notification the app shell throttles into a
///      one-time "couldn't save on this device" notice once writes are
///      *persistently* failing (not on a single transient blip).
enum PersistenceHealth {

    /// Posted whenever a local save fails. The shell observes this (debounced to
    /// the main run loop) and surfaces a throttled notice; tests assert it fires.
    /// Posting thread is whatever called `saveOrLog`; observers must hop to main.
    static let saveFailedNotification = Notification.Name("com.gradethread.app.localSaveFailed")

    /// Records a local-save failure: a scrubbed breadcrumb plus a notification.
    /// `nonisolated` so the `SyncMergeActor`, the nonisolated
    /// `OfflineMutationQueue`, and `@MainActor` stores can all call it from
    /// within their own isolation with no hop at the call site.
    nonisolated static func recordSaveFailure(operation: String, error: Error) {
        Telemetry.backgroundBreadcrumb(
            "SwiftData save failed [\(operation)]: \(error.localizedDescription)",
            category: "persistence"
        )
        #if DEBUG
        print("[Persistence] save failed [\(operation)]: \(error)")
        #endif
        NotificationCenter.default.post(
            name: saveFailedNotification,
            object: nil,
            userInfo: ["operation": operation]
        )
    }
}
