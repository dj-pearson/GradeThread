import Foundation
import SwiftData

extension ModelContext {

    /// Saves the context, and on failure records it (scrubbed breadcrumb + a
    /// main-thread notification the shell can throttle) instead of silently
    /// swallowing the error the way `try? save()` did (US-1142).
    ///
    /// Returns whether the save succeeded so callers that care can branch (e.g.
    /// keep a task in a retryable `.failed` state) without each site
    /// reimplementing telemetry. `@discardableResult` so the common
    /// fire-and-forget call sites stay terse.
    ///
    /// `operation` is a short, non-PII label (typically the enclosing function)
    /// used only for the breadcrumb — never pass user content.
    ///
    /// The `hasChanges` guard makes a no-op save genuinely free (and avoids
    /// emitting a misleading "save" breadcrumb category for empty contexts);
    /// SwiftData's `save()` is already a no-op with no pending changes.
    @discardableResult
    func saveOrLog(_ operation: String) -> Bool {
        guard hasChanges else { return true }
        do {
            try save()
            return true
        } catch {
            PersistenceHealth.recordSaveFailure(operation: operation, error: error)
            return false
        }
    }
}
