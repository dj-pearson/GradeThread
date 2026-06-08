import Foundation

/// Per-table "last synced" watermark backing the incremental (delta) sync
/// (US-633). Stores the high-water `updated_at` / `created_at` timestamp we've
/// successfully merged for each table so the next pull only asks the server for
/// rows newer than that, instead of re-downloading the whole catalog every
/// foreground / pull-to-refresh / background pass.
///
/// Watermarks are persisted in `UserDefaults` (small scalars, survive launch)
/// and advanced ONLY after a successful merge — a failed/partial pull leaves
/// the previous watermark in place so the missed rows come back next pass.
///
/// On sign-out the whole set is reset (``resetAll``) so the next user does a
/// clean full backfill rather than inheriting the previous account's cursor.
struct SyncWatermark {
    /// Logical tables the engine deltas independently. `inventory_items` deltas
    /// on `updated_at`; `item_photos` and `sales` have no `updated_at` column
    /// (see migrations 00008 / 00002), so they delta on `created_at` — new rows
    /// stream in incrementally and edits to existing rows arrive via Realtime
    /// (US-198) or the next full backfill.
    enum Table: String, CaseIterable {
        case inventoryItems = "inventory_items"
        case itemPhotos = "item_photos"
        case sales = "sales"

        /// The timestamp column the delta filter compares against.
        var cursorColumn: String {
            switch self {
            case .inventoryItems: return "updated_at"
            case .itemPhotos, .sales: return "created_at"
            }
        }
    }

    private let defaults: UserDefaults
    private static let keyPrefix = "com.gradethread.app.syncWatermark."

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func key(for table: Table) -> String { Self.keyPrefix + table.rawValue }

    /// The last successfully-merged cursor for `table`, or nil when we've never
    /// synced it (→ first run does a full backfill).
    func value(for table: Table) -> String? {
        defaults.string(forKey: key(for: table))
    }

    /// Advance the watermark. Monotonic: never moves backwards, so an
    /// out-of-order page (rows can arrive unsorted across pages) can't rewind
    /// the cursor and cause re-fetches.
    func advance(_ table: Table, to candidate: String?) {
        guard let candidate, !candidate.isEmpty else { return }
        if let current = value(for: table), current >= candidate { return }
        defaults.set(candidate, forKey: key(for: table))
    }

    /// Wipe every table's cursor (sign-out / account switch). The next pull is
    /// a full backfill.
    func resetAll() {
        for table in Table.allCases { defaults.removeObject(forKey: key(for: table)) }
    }
}
