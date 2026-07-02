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
        /// US-750: operating expenses now mirror into the shared cache too. Like
        /// sales they have no `updated_at`, so they delta on `created_at`.
        case expenses = "flipdesk_expenses"
        /// US-819: grade disputes mirror into the cache so the Grades list can
        /// show a per-row dispute badge. `disputes` HAS an `updated_at` column
        /// (a status change bumps it), so they delta on `updated_at`.
        case disputes = "disputes"
        /// US-1221: listings were the one un-watermarked table — re-fetched in
        /// full (up to `maxRowsPerPass`) on every pass. `listings` HAS an
        /// `updated_at` column (bumped by the trigger on every edit, including
        /// eBay-driven price/status changes), so they now delta on `updated_at`
        /// like inventory_items. Each item's latest listing price is derived
        /// from the cached `LocalListing` rows after the delta merges, instead
        /// of from a whole-table fetch every pass.
        case listings = "listings"

        /// The timestamp column the delta filter compares against. US-1515: every
        /// synced table now has an `updated_at` bumped on edit (sales + item_photos
        /// gained one in migration 00332; flipdesk_expenses had one since 00019),
        /// so ALL tables delta on `updated_at` — a server-side EDIT (sale
        /// correction, photo retag/reorder) now moves the cursor and reaches the
        /// device, instead of only inserts (created_at) doing so.
        var cursorColumn: String { "updated_at" }
    }

    private let defaults: UserDefaults
    private static let keyPrefix = "com.gradethread.app.syncWatermark."
    private static let versionKey = "com.gradethread.app.syncWatermark.schemaVersion"

    /// Bump this whenever a sync change requires a one-time full backfill for
    /// EXISTING installs (not just fresh ones). On a version mismatch we reset
    /// every cursor so the next pull is a full backfill.
    ///   v2 (00111): prune stale items (fixes inflated "listed" counts),
    ///   backfill listing prices for market value, and pull the new sale
    ///   status / cost columns.
    ///   v3 (US-750): expenses now sync into the shared cache — force a one-time
    ///   full backfill so existing installs populate `LocalExpense`.
    ///   v4 (US-819): items now sync `grade_report_id` and disputes sync into the
    ///   cache — force a one-time full backfill so existing installs populate the
    ///   linkage + dispute badges.
    ///   v5 (US-1515): sales / item_photos / expenses now delta on `updated_at`
    ///   instead of `created_at` — force a one-time full backfill so existing
    ///   installs re-pull every row onto the new cursor and stop missing edits.
    private static let currentSchemaVersion = 5

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // One-time forced full backfill when the sync schema version changes.
        if defaults.integer(forKey: Self.versionKey) != Self.currentSchemaVersion {
            for table in Table.allCases {
                defaults.removeObject(forKey: Self.keyPrefix + table.rawValue)
            }
            defaults.set(Self.currentSchemaVersion, forKey: Self.versionKey)
        }
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
