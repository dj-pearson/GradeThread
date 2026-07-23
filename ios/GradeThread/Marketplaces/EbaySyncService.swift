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
    /// Long-lived engine that owns the pull→merge loop. When injected the
    /// completion path awaits ``SyncEngine/sync()`` directly so the summary
    /// counts reflect the just-merged rows deterministically (US-1007) instead
    /// of firing a notification and sleeping a fixed beat.
    private let syncEngine: SyncEngine?

    // Internal (not `public`): the `syncEngine` parameter is the internal
    // `SyncEngine` actor, and a `public init` may not expose an internal type.
    // The service is only ever constructed within this app target, so internal
    // access is sufficient.
    init(
        supabase: SupabaseClient = SupabaseShared.client,
        container: ModelContainer? = nil,
        syncEngine: SyncEngine? = nil,
        policy: PollingPolicy = .default
    ) {
        self.supabase = supabase
        self.container = container
        self.syncEngine = syncEngine
        self.policy = policy
    }

    /// Cached ISO-8601 parsers. Allocating an `ISO8601DateFormatter` is
    /// expensive; the poll comparator (`didAdvance`) runs on every tick, so we
    /// reuse these instead of building a fresh pair per call (US-1007).
    private static let isoFull: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    /// Parses an ISO-8601 timestamp (with or without fractional seconds),
    /// returning nil when neither precision matches so callers can fall back.
    private static func parseISODate(_ s: String) -> Date? {
        isoFull.date(from: s) ?? isoPlain.date(from: s)
    }

    // MARK: - Public API

    /// Snapshot the local cache + connection's last_synced_at right
    /// before kicking off a sync. The completion path subtracts these
    /// from the post-sync values for the summary deltas.
    public func snapshot(userId: String) async -> EbaySyncBaseline {
        let (listings, activeListings, sales) = countLocalRows()
        // US-1003: distinguish a genuinely-nil cursor (first-ever sync) from a
        // FAILED fetch. The old `try?` coerced both to nil, so a transient query
        // failure looked identical to a first sync — risking a full/duplicate
        // pull or a skipped window with no trace. On error we breadcrumb and
        // still fall back to nil (sync proceeds, no user-facing error); a real
        // first-sync stays silent.
        let lastSyncedAt: String?
        do {
            lastSyncedAt = try await fetchLastSyncedAt(userId: userId)
        } catch {
            Telemetry.breadcrumb(
                "eBay sync baseline: fetchLastSyncedAt failed, treating as first-sync — \(error.localizedDescription)",
                category: "ebay"
            )
            lastSyncedAt = nil
        }
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
        Telemetry.breadcrumb("eBay sync started", category: "ebay")

        // 1. Fire the request. We don't carry the 202 body anywhere —
        //    the wire shape only confirms the schema.
        do {
            struct EmptyBody: Encodable {}
            let _: ListingsPullStarted = try await EdgeAPI.shared.postJSON(
                "/api/flipdesk/ebay/listings/pull",
                body: EmptyBody()
            )
        } catch let error as EdgeAPIError {
            Telemetry.breadcrumb(
                "eBay sync failed to start: \(error.errorDescription ?? "unknown")",
                category: "ebay"
            )
            return .failed(message: error.errorDescription ?? "Couldn't start sync.")
        } catch {
            return .failed(message: error.localizedDescription)
        }

        // 2. Poll until last_synced_at advances or we hit the deadline.
        // US-638: exponential backoff (base = policy.interval, capped) instead
        // of a fixed interval so a slow sync stops polling every few seconds.
        let deadline = Date.now.addingTimeInterval(policy.timeout)
        var pollAttempt = 0
        // US-792: don't silently spin to the deadline when the poll endpoint is
        // unreachable. Track consecutive failures and bail with a distinct
        // "lost connection" result (vs. the .timedOut you'd otherwise see),
        // recording each failure so support can diagnose.
        var consecutivePollFailures = 0
        let maxConsecutivePollFailures = 3
        var lastPollError: String?
        while Date.now < deadline {
            // US-1007: yield promptly when the modal is dismissed. The caller's
            // sync Task is cancelled on dismiss; bail instead of finishing the
            // whole poll window (the pull keeps running server-side regardless).
            if Task.isCancelled { return .timedOut }
            do {
                try await Task.sleep(
                    nanoseconds: Backoff.jitteredDelayNanos(attempt: pollAttempt, base: policy.interval, cap: max(policy.interval, 8))
                )
            } catch {
                // Sleep throws CancellationError when the Task is cancelled
                // (modal dismissed / continue-in-background) — stop polling now.
                return .timedOut
            }
            pollAttempt += 1

            do {
                let snapshot = try await fetchConnectionSnapshot(userId: userId)
                consecutivePollFailures = 0 // a reachable server clears the streak
                // Refresh error overrides whatever last_synced_at says —
                // the connection's broken and the sync didn't complete
                // even if the timestamp moved.
                if let error = snapshot?.refresh_error, !error.isEmpty {
                    return .connectionFlagged(message: error)
                }
                if didAdvance(baseline: baseline, current: snapshot?.last_synced_at) {
                    let summary = await buildSummary(baseline: baseline)
                    Telemetry.breadcrumb("eBay sync completed", category: "ebay")
                    Telemetry.event(TelemetryEvent.ebaySynced, props: [
                        "listings_total": summary.listingsCount,
                        "sales_total": summary.salesCount,
                        "listings_delta": summary.listingsDelta,
                        "sales_delta": summary.salesDelta,
                    ])
                    return .completed(summary)
                }
            } catch {
                // US-792: a poll failed. Record it; tolerate a few transient
                // blips, but if the endpoint stays unreachable, stop early and
                // tell the user it's a connection problem rather than letting
                // the whole window elapse into a misleading "timed out".
                consecutivePollFailures += 1
                lastPollError = (error as? EdgeAPIError)?.errorDescription
                    ?? error.localizedDescription
                Telemetry.breadcrumb(
                    "eBay sync poll failed (\(consecutivePollFailures)/\(maxConsecutivePollFailures)): \(lastPollError ?? "unknown")",
                    category: "ebay"
                )
                if consecutivePollFailures >= maxConsecutivePollFailures {
                    return .failed(
                        message: "Lost connection while syncing — check your network and try again."
                    )
                }
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
        // US-1216: poll the PRIMARY connection's row — the same one the edge
        // advances (`/listings/pull` orders is_primary DESC) and
        // EbayConnectionService.fetchActiveConnection resolves. Ordering by
        // created_at DESC instead would, for a multi-store user whose primary is
        // not the newest connection, poll the wrong row's last_synced_at — so
        // didAdvance never flips and the sync modal hits .timedOut after 90s even
        // though sync succeeded (and it masks a real refresh_error on the primary).
        let rows: [ConnectionSnapshot] = try await supabase
            .from("marketplace_connections")
            .select("id, last_synced_at, refresh_error")
            .eq("user_id", value: userId)
            .eq("marketplace", value: "ebay")
            .eq("is_active", value: true)
            .order("is_primary", ascending: false)
            .order("updated_at", ascending: false)
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
        if let lhs = Self.parseISODate(current), let rhs = Self.parseISODate(baselineString) {
            return lhs > rhs
        }
        return current > baselineString
    }

    private func buildSummary(baseline: EbaySyncBaseline) async -> EbaySyncSummary {
        // Settle the local cache against the just-synced server state BEFORE
        // counting. US-1007: await the engine pull directly so the counts are
        // deterministic — the old path fired a notification then slept a fixed
        // 1.2s and hoped the merge had landed (a race with the local refresh).
        if let syncEngine {
            await syncEngine.sync()
        } else {
            // No engine injected (legacy callers / unit tests with no container)
            // — fall back to the notification ContentView routes to the engine.
            requestLocalRefresh()
        }

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
