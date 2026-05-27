import Foundation
import Supabase
import SwiftData

/// Drives the "sync from eBay" flow. Three steps:
///
///   1. Snapshot the pre-sync state (counts + last_synced_at) so the
///      completion summary can show deltas.
///   2. POST `/api/flipdesk/ebay/listings/pull`. The endpoint returns 202
///      immediately and runs the actual sync detached.
///   3. Poll `marketplace_connections.last_synced_at` every `pollInterval`
///      until it advances past the snapshot value, fails over to
///      `refresh_error`, or hits `timeout`.
@MainActor
public final class EbaySyncService {

    public struct PollingPolicy: Equatable {
        public var interval: TimeInterval
        public var timeout: TimeInterval

        public static let `default` = PollingPolicy(interval: 3, timeout: 90)
    }

    private let supabase: SupabaseClient
    private let container: ModelContainer?
    private let policy: PollingPolicy

    public init(
        supabase: SupabaseClient = SupabaseShared.client,
        container: ModelContainer? = nil,
        policy: PollingPolicy = .default
    ) {
        self.supabase = supabase
        self.container = container
        self.policy = policy
    }

    // MARK: - Public API

    /// Snapshot the local cache + connection's last_synced_at right
    /// before kicking off a sync. The completion path subtracts these
    /// from the post-sync values for the summary deltas.
    public func snapshot(userId: String) async -> EbaySyncBaseline {
        let (listings, activeListings, sales) = countLocalRows()
        let lastSyncedAt = (try? await fetchLastSyncedAt(userId: userId)) ?? nil
        return EbaySyncBaseline(
            listings: listings,
            activeListings: activeListings,
            sales: sales,
            lastSyncedAt: lastSyncedAt
        )
    }

    /// Fires the sync and polls until completion. Returns one of:
    ///   - `.completed(summary)` once `last_synced_at` advances + the
    ///     SyncEngine pull has refreshed local counts
    ///   - `.timedOut` if the poll deadline hits without advance
    ///   - `.connectionFlagged(message:)` if the refresh worker
    ///     populated `refresh_error` mid-sync
    ///   - `.failed(message:)` for HTTP / network failure
    public func sync(userId: String, baseline: EbaySyncBaseline) async -> EbaySyncCompletion {
        // 1. Fire the request. We don't carry the 202 body anywhere —
        //    the wire shape only confirms the schema.
        do {
            struct EmptyBody: Encodable {}
            let _: ListingsPullStarted = try await EdgeAPI.shared.postJSON(
                "/api/flipdesk/ebay/listings/pull",
                body: EmptyBody()
            )
        } catch let error as EdgeAPIError {
            return .failed(message: error.errorDescription ?? "Couldn't start sync.")
        } catch {
            return .failed(message: error.localizedDescription)
        }

        // 2. Poll until last_synced_at advances or we hit the deadline.
        let deadline = Date.now.addingTimeInterval(policy.timeout)
        while Date.now < deadline {
            try? await Task.sleep(nanoseconds: UInt64(policy.interval * 1_000_000_000))

            do {
                let snapshot = try await fetchConnectionSnapshot(userId: userId)
                // Refresh error overrides whatever last_synced_at says —
                // the connection's broken and the sync didn't complete
                // even if the timestamp moved.
                if let error = snapshot?.refresh_error, !error.isEmpty {
                    return .connectionFlagged(message: error)
                }
                if didAdvance(baseline: baseline, current: snapshot?.last_synced_at) {
                    return .completed(await buildSummary(baseline: baseline))
                }
            } catch {
                // Transient poll failure — keep going until the deadline.
                continue
            }
        }
        return .timedOut
    }

    /// Pull-through to ``SyncEngine.pull`` via the existing
    /// `.inventoryPullRequested` notification. Called from the
    /// completion path so the inventory list reflects new rows.
    public func requestLocalRefresh() {
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }

    // MARK: - Internals

    private struct ConnectionSnapshot: Decodable {
        let id: String
        let last_synced_at: String?
        let refresh_error: String?
    }

    private func fetchConnectionSnapshot(userId: String) async throws -> ConnectionSnapshot? {
        let rows: [ConnectionSnapshot] = try await supabase
            .from("marketplace_connections")
            .select("id, last_synced_at, refresh_error")
            .eq("user_id", value: userId)
            .eq("marketplace", value: "ebay")
            .eq("is_active", value: true)
            .order("created_at", ascending: false)
            .limit(1)
            .execute()
            .value
        return rows.first
    }

    private func fetchLastSyncedAt(userId: String) async throws -> String? {
        try await fetchConnectionSnapshot(userId: userId)?.last_synced_at
    }

    /// Returns true iff the freshly-polled `last_synced_at` is non-nil
    /// AND strictly newer than the snapshot. A nil-current (connection
    /// disappeared mid-sync) doesn't count as advance.
    func didAdvance(baseline: EbaySyncBaseline, current: String?) -> Bool {
        guard let current else { return false }
        guard let baselineString = baseline.lastSyncedAt else {
            // First-ever sync — any value is an advance.
            return true
        }
        // String compare works for ISO 8601 with the same precision;
        // dates parse to be safe across mixed-precision sources.
        if current == baselineString { return false }
        let parseDate: (String) -> Date? = { s in
            let isoFull = ISO8601DateFormatter()
            isoFull.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return isoFull.date(from: s) ?? ISO8601DateFormatter().date(from: s)
        }
        if let lhs = parseDate(current), let rhs = parseDate(baselineString) {
            return lhs > rhs
        }
        return current > baselineString
    }

    private func buildSummary(baseline: EbaySyncBaseline) async -> EbaySyncSummary {
        // Let the SyncEngine pull pick up the fresh rows so the count
        // queries below reflect the just-synced state. We post the
        // notification and wait a beat; ContentView routes it to
        // syncEngine.sync().
        requestLocalRefresh()
        try? await Task.sleep(nanoseconds: 1_200_000_000)

        let (listings, activeListings, sales) = countLocalRows()
        return EbaySyncSummary(
            listingsCount: listings,
            activeListingsCount: activeListings,
            salesCount: sales,
            listingsDelta: listings - baseline.listings,
            salesDelta: sales - baseline.sales
        )
    }

    /// Counts rows in the local cache. Returns zeros when no
    /// ModelContainer is injected (tests that don't need the deltas).
    private func countLocalRows() -> (listings: Int, active: Int, sales: Int) {
        guard let container else { return (0, 0, 0) }
        let context = ModelContext(container)
        let listingsCount = (try? context.fetchCount(FetchDescriptor<LocalListing>())) ?? 0
        let active = (try? context.fetchCount(FetchDescriptor<LocalListing>(
            predicate: #Predicate { $0.listingStatus == "active" }
        ))) ?? 0
        let salesCount = (try? context.fetchCount(FetchDescriptor<LocalSale>())) ?? 0
        return (listingsCount, active, salesCount)
    }
}
