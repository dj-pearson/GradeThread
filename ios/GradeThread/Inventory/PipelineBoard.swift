import Foundation

/// A single column in the FlipDesk inventory pipeline board. Mirrors one entry
/// of the web `FLIPDESK_PIPELINE` constant (`src/lib/constants.ts`) — the
/// canonical status, its display label, and the next-action hint shown under the
/// column header.
struct PipelineColumn: Identifiable, Hashable {
    let status: String
    let label: String
    let nextAction: String
    var id: String { status }
}

/// US-813: pure, dependency-free model for the inventory kanban board.
///
/// The column set + order is the iOS mirror of the web `FLIPDESK_PIPELINE`
/// (`src/lib/constants.ts`) — keep the two in sync. Grouping and the stage-move
/// reducer live here as pure functions so they unit-test without SwiftData or
/// the network; the board view and ``BulkActionExecutor`` just apply the result.
enum PipelineBoard {
    /// Columns in display order — identical ordering to web `FLIPDESK_PIPELINE`.
    static let columns: [PipelineColumn] = [
        .init(status: "sourced",      label: "Sourced",      nextAction: "Catalog basic info"),
        .init(status: "cataloged",    label: "Cataloged",    nextAction: "Measure"),
        .init(status: "measured",     label: "Measured",     nextAction: "Photograph"),
        .init(status: "photographed", label: "Photographed", nextAction: "Send to GradeThread"),
        .init(status: "grading",      label: "Grading",      nextAction: "Awaiting grade"),
        .init(status: "graded",       label: "Graded",       nextAction: "Run comps"),
        .init(status: "comped",       label: "Comped",       nextAction: "Draft listing"),
        .init(status: "drafted",      label: "Drafted",      nextAction: "Push to eBay"),
        .init(status: "listed",       label: "Listed",       nextAction: "Wait for sale"),
        .init(status: "sold",         label: "Sold",         nextAction: "Ship"),
        .init(status: "shipped",      label: "Shipped",      nextAction: "Confirm delivery"),
        .init(status: "completed",    label: "Completed",    nextAction: "Archive"),
        .init(status: "returned",     label: "Returned",     nextAction: "Relist or write off"),
    ]

    /// Column statuses in display order.
    static let statusOrder: [String] = columns.map(\.status)

    /// Statuses that map to a board column. A status outside this set (e.g.
    /// `archived`, `keeping`, `wearing`) has no column and its items aren't shown
    /// on the board — same as the web pipeline, which only renders
    /// `FLIPDESK_PIPELINE` columns.
    static let columnStatuses: Set<String> = Set(statusOrder)

    /// Display label for a status, falling back to a Title-Cased rendering of an
    /// unknown status (via ``StatusBadge/label(for:)``) so the board never shows
    /// a raw snake_case value.
    static func label(for status: String) -> String {
        columns.first { $0.status == status }?.label ?? StatusBadge.label(for: status)
    }

    /// Pure grouping: buckets `items` by board status, preserving input order
    /// within each bucket. Items whose status has no column are dropped. Every
    /// column status is present in the result (empty array when it has no items)
    /// so the board can render zero-item columns with an empty state.
    static func group<Item>(_ items: [Item], status: (Item) -> String) -> [String: [Item]] {
        var buckets: [String: [Item]] = [:]
        for col in statusOrder { buckets[col] = [] }
        for item in items where buckets[status(item)] != nil {
            buckets[status(item)]?.append(item)
        }
        return buckets
    }

    /// Pure stage-move reducer. Given an item's current status and a requested
    /// target, returns the move to apply, or `nil` when it's a no-op: the target
    /// equals the current status, or the target isn't a board column. Callers
    /// keep ``PipelineMove/from`` to revert an optimistic write the server rejects.
    /// Moves are unrestricted in either direction (the board enforces no ordering).
    static func planMove(from current: String, to target: String) -> PipelineMove? {
        guard current != target, columnStatuses.contains(target) else { return nil }
        return PipelineMove(from: current, to: target)
    }
}

/// A planned stage transition produced by ``PipelineBoard/planMove(from:to:)``.
/// `from` is retained so a failed optimistic write can be reverted.
struct PipelineMove: Equatable {
    let from: String
    let to: String
}
