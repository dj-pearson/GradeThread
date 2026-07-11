import Foundation

/// Pure ordering primitives for the incremental (delta) sync — the keyset
/// watermark cursor rule and the mid-pull scope-epoch guard. Both are plain
/// value-in / value-out functions with no SwiftData, actor, or network
/// dependency, so they live in GradeThreadCore and unit-test on Linux
/// (`swift test`, no Mac). ``SyncEngine`` calls straight through to these.
public enum SyncOrdering {

    /// US-1493: whether a completed pull's results may be applied. False when the
    /// scope epoch moved while the fetch was in flight (a workspace switch /
    /// sign-out mid-pull) — the rows belong to the previous tenant, so neither the
    /// merge nor the watermark advance may run.
    public static func pullResultApplies(startEpoch: Int, currentEpoch: Int) -> Bool {
        startEpoch == currentEpoch
    }

    /// US-1210: the cursor value to advance a watermark to that never skips a
    /// dropped (undecodable) row. Returns the greatest *decoded* cursor that sorts
    /// strictly before the earliest *dropped* row, so the next delta pull
    /// (`gt(cursor, watermark)`) re-fetches the dropped row — and re-attempts its
    /// decode — once it becomes valid. With no drops this is the page's max cursor
    /// (parity with the old `payload.map(\.cursor).max()`); `nil` means "don't
    /// advance". Cursor strings are ISO-8601 and compared lexically, matching
    /// ``SyncWatermark.advance(_:to:)``'s ordering.
    public static func safeCursor(decodedCursors: [String], droppedCursors: [String]) -> String? {
        guard let earliestDropped = droppedCursors.min() else { return decodedCursors.max() }
        return decodedCursors.filter { $0 < earliestDropped }.max()
    }
}
