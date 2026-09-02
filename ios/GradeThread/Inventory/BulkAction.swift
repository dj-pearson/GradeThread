import Foundation

/// One bulk action surfaced in the bottom action bar. Stage-appropriate
/// — `actions(for:)` returns the right set for the active inventory tab.
///
/// The eBay-backed actions (drop price, end listing) are wired through
/// ``BulkActionExecutor`` to the edge publish endpoints (US-185); each
/// item that has no active eBay listing fails individually with a reason
/// rather than failing the whole batch.
///
/// US-1130: the former `aiEnrich` case was removed — its executor was a
/// permanent stub that never appeared in any visible action set, so it was a
/// dead, half-advertised AI capability. Per-item AI enrichment still lives on
/// the item canvas (``AIFillReviewSheet``); there is no bulk path on iOS.
public enum BulkAction: Identifiable, Hashable {
    case createDraft
    /// US-680: validate + push each selected item to eBay in one batch.
    case publish
    case markShipped
    case endListing
    /// Percent reduction (e.g. 10 for -10%). Surfaced as a single button
    /// because that's how the web copy reads.
    case dropPrice(percent: Int)
    /// Submit the selection for certified grading. Unlike the others this
    /// doesn't run through ``BulkActionExecutor`` — the InventoryListView
    /// intercepts it to present a dedicated batch-grading sheet (tier +
    /// readiness + credits).
    case grade
    case exportCSV

    public var id: String {
        switch self {
        case .createDraft:        return "create_draft"
        case .publish:            return "publish"
        case .markShipped:        return "mark_shipped"
        case .endListing:         return "end_listing"
        case .dropPrice(let pct): return "drop_price_\(pct)"
        case .grade:              return "grade"
        case .exportCSV:          return "export_csv"
        }
    }

    public var label: String {
        switch self {
        case .createDraft:        return "Create draft"
        case .publish:            return "Publish"
        case .markShipped:        return "Mark shipped"
        case .endListing:         return "End listing"
        case .dropPrice(let pct): return "Drop -\(pct)%"
        case .grade:              return "Grade"
        case .exportCSV:          return "Export CSV"
        }
    }

    public var systemImage: String {
        switch self {
        case .createDraft: return "doc.text"
        case .publish:     return "paperplane.fill"
        case .markShipped: return "shippingbox.fill"
        case .endListing:  return "stop.circle"
        case .dropPrice:   return "arrow.down.circle"
        case .grade:       return "checkmark.seal"
        case .exportCSV:   return "square.and.arrow.up"
        }
    }

    public var isDestructive: Bool {
        switch self {
        case .endListing: return true
        default:          return false
        }
    }

    /// Confirmation copy phrased per-action. `count` slots in the
    /// number-of-rows the action will touch.
    public func confirmationTitle(count: Int) -> String {
        let suffix = count == 1 ? "item" : "items"
        switch self {
        case .createDraft:        return "Create \(count) \(suffix) as drafts?"
        case .publish:            return "Publish \(count) \(suffix) to eBay?"
        case .markShipped:        return "Mark \(count) \(suffix) as shipped?"
        case .endListing:         return "End \(count) \(suffix)?"
        case .dropPrice(let pct): return "Drop price -\(pct)% on \(count) \(suffix)?"
        case .grade:              return "Grade \(count) \(suffix)?"
        case .exportCSV:          return "Export \(count) \(suffix) as CSV?"
        }
    }

    /// Stage-appropriate action sets, mirroring src/pages/flipdesk/listings.tsx
    /// bottom-bar predicate.
    public static func actions(for stage: InventoryStage) -> [BulkAction] {
        switch stage {
        case .unlisted:
            // Unlisted holds undrafted and drafted rows together, so it offers
            // both halves: Create draft for the first, Publish for the second.
            // .grade IS surfaced: InventoryListView intercepts it into the
            // dedicated bulk-grade sheet (it never hits the executor path).
            return [.publish, .grade, .createDraft, .exportCSV]
        case .active:
            return [.dropPrice(percent: 10), .endListing, .exportCSV]
        case .sold:
            return [.markShipped, .exportCSV]
        case .shipped:
            return [.exportCSV]
        case .returned:
            return [.exportCSV]
        case .all:
            // Mixed-status selection — restrict to non-destructive
            // actions that work uniformly. Per-action validation in
            // BulkActionExecutor still kicks in.
            return [.exportCSV]
        }
    }
}

/// Outcome of executing a bulk action across a set of items. Caller
/// renders `summary` as a toast and `failures` in a follow-up list when
/// non-empty.
public struct BulkActionResult: Equatable {
    public let action: BulkAction
    public let succeeded: Int
    public let failures: [Failure]
    /// US-1506: non-fatal notices — e.g. a listing that ended in FlipDesk but
    /// whose eBay withdraw didn't actually happen (already inactive / no linked
    /// offer). These items still count toward `succeeded`; the warning tells the
    /// seller the eBay side may be unchanged so they can verify.
    public var warnings: [String] = []

    public struct Failure: Equatable {
        public let itemId: String
        public let message: String
    }

    public var total: Int { succeeded + failures.count }

    public var summary: String {
        let suffix = total == 1 ? "item" : "items"
        let base: String
        if failures.isEmpty {
            base = "Updated \(succeeded) \(suffix)."
        } else if succeeded == 0 {
            base = "All \(failures.count) \(suffix) failed."
        } else {
            base = "Updated \(succeeded) of \(total) \(suffix); \(failures.count) failed."
        }
        if warnings.isEmpty { return base }
        // Surface a single representative notice inline; the caller can render
        // the full `warnings` list if it wants more detail.
        return "\(base) \(warnings.count == 1 ? warnings[0] : "\(warnings.count) listings ended in FlipDesk only — verify on eBay.")"
    }
}
