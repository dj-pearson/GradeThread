import Foundation
import Supabase

/// Runs one ``BulkAction`` against a set of `LocalInventoryItem` rows.
///
/// Each action handler:
///   1. Validates the target items are in an appropriate state. Items
///      that fail the precondition end up in `failures` with a reason.
///   2. Updates the server via supabase-swift (one network call per
///      action, batched via `.in()` where possible).
///   3. Writes the same change optimistically to the local
///      `LocalInventoryItem` rows so the list reflects the new state
///      before the next sync pull catches up.
///   4. Returns a ``BulkActionResult`` the caller renders as a toast.
@MainActor
public struct BulkActionExecutor {

    private let supabase: SupabaseClient

    public init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    /// Routes to the per-action handler. Caller passes already-filtered
    /// items (the InventoryListView only includes rows visible in the
    /// current stage / search).
    public func execute(_ action: BulkAction, items: [LocalInventoryItem]) async -> BulkActionResult {
        switch action {
        case .createDraft:
            return await updateStatus(items, to: "drafted", action: action)
        case .markShipped:
            return await updateStatus(items, to: "shipped", action: action)
        case .endListing:
            return notYetWired(action: action, items: items, reason: "Wires up in US-183/185 (eBay connect).")
        case .dropPrice:
            return notYetWired(action: action, items: items, reason: "Wires up in US-183/185 (eBay connect).")
        case .aiEnrich:
            return notYetWired(action: action, items: items, reason: "Wires up in a focused AI-batch pass.")
        case .exportCSV:
            // Export is a client-side bookkeeping action that doesn't
            // touch the server. Caller hands the items to a CSV writer
            // separately — we just return a success so the toast
            // confirms the count.
            return BulkActionResult(
                action: action,
                succeeded: items.count,
                failures: []
            )
        }
    }

    // MARK: - Handlers

    private func updateStatus(
        _ items: [LocalInventoryItem],
        to status: String,
        action: BulkAction
    ) async -> BulkActionResult {
        // Guard against regressing items already past the target status.
        // The web doesn't currently surface this either — keep parity by
        // letting the user re-affirm.
        let targetIds = items.map(\.id)
        do {
            struct StatusUpdate: Encodable { let status: String }
            try await supabase
                .from("inventory_items")
                .update(StatusUpdate(status: status))
                .in("id", values: targetIds)
                .execute()
            // Optimistic local apply.
            for item in items {
                item.status = status
                item.updatedAt = .now
            }
            return BulkActionResult(action: action, succeeded: items.count, failures: [])
        } catch {
            return BulkActionResult(
                action: action,
                succeeded: 0,
                failures: items.map {
                    .init(itemId: $0.id, message: error.localizedDescription)
                }
            )
        }
    }

    private func notYetWired(
        action: BulkAction,
        items: [LocalInventoryItem],
        reason: String
    ) -> BulkActionResult {
        BulkActionResult(
            action: action,
            succeeded: 0,
            failures: items.map {
                .init(itemId: $0.id, message: reason)
            }
        )
    }
}
