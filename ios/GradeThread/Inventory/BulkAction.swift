import Foundation

/// One bulk action surfaced in the bottom action bar. Stage-appropriate
/// — `actions(for:)` returns the right set for the active inventory tab.
///
/// The eBay-backed actions (drop price, end listing) are wired through
/// ``BulkActionExecutor`` to the edge publish endpoints (US-185); each
/// item that has no active eBay listing fails individually with a reason
/// rather than failing the whole batch. `aiEnrich` is the one action whose
/// execute path is still a stub (returns a per-item "not yet wired" reason)
/// pending the AI-batch pass.
public enum BulkAction: Identifiable, Hashable {
    case createDraft
    case markShipped
    case endListing
    /// Percent reduction (e.g. 10 for -10%). Surfaced as a single button
    /// because that's how the web copy reads.
    case dropPrice(percent: Int)
    case aiEnrich
    case exportCSV

    public var id: String {
        switch self {
        case .createDraft:        return "create_draft"
        case .markShipped:        return "mark_shipped"
        case .endListing:         return "end_listing"
        case .dropPrice(let pct): return "drop_price_\(pct)"
        case .aiEnrich:           return "ai_enrich"
        case .exportCSV:          return "export_csv"
        }
    }

    public var label: String {
        switch self {
        case .createDraft:        return "Create draft"
        case .markShipped:        return "Mark shipped"
        case .endListing:         return "End listing"
        case .dropPrice(let pct): return "Drop -\(pct)%"
        case .aiEnrich:           return "AI enrich"
        case .exportCSV:          return "Export CSV"
        }
    }

    public var systemImage: String {
        switch self {
        case .createDraft: return "doc.text"
        case .markShipped: return "shippingbox.fill"
        case .endListing:  return "stop.circle"
        case .dropPrice:   return "arrow.down.circle"
        case .aiEnrich:    return "sparkles"
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
        case .markShipped:        return "Mark \(count) \(suffix) as shipped?"
        case .endListing:         return "End \(count) \(suffix)?"
        case .dropPrice(let pct): return "Drop price -\(pct)% on \(count) \(suffix)?"
        case .aiEnrich:           return "Run AI enrich on \(count) \(suffix)?"
        case .exportCSV:          return "Export \(count) \(suffix) as CSV?"
        }
    }

    /// Stage-appropriate action sets, mirroring src/pages/flipdesk/listings.tsx
    /// bottom-bar predicate.
    public static func actions(for stage: InventoryStage) -> [BulkAction] {
        switch stage {
        case .toList:
            return [.createDraft, .aiEnrich, .exportCSV]
        case .drafts:
            return [.exportCSV]
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

    public struct Failure: Equatable {
        public let itemId: String
        public let message: String
    }

    public var total: Int { succeeded + failures.count }

    public var summary: String {
        let suffix = total == 1 ? "item" : "items"
        if failures.isEmpty {
            return "Updated \(succeeded) \(suffix)."
        }
        if succeeded == 0 {
            return "All \(failures.count) \(suffix) failed."
        }
        return "Updated \(succeeded) of \(total) \(suffix); \(failures.count) failed."
    }
}
