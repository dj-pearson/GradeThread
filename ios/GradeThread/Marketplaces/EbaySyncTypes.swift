import Foundation

/// 202 response from `POST /api/flipdesk/ebay/listings/pull`. The endpoint
/// fires the heavy sync as a detached background task and returns
/// immediately; clients poll `marketplace_connections.last_synced_at` to
/// detect completion.
struct ListingsPullStarted: Decodable {
    /// The web's response includes `ok: true` and a status message. We
    /// don't actually need either client-side but decoding them surfaces
    /// any future schema change.
    let ok: Bool
    let message: String?
}

/// Outcome of a single sync run. The summary fields are best-effort
/// estimates computed from local counts before/after the post-sync pull,
/// not server-emitted totals — the edge endpoint runs detached and
/// doesn't return counts directly.
public struct EbaySyncSummary: Equatable {
    public let listingsCount: Int
    public let activeListingsCount: Int
    public let salesCount: Int

    /// Delta over the pre-sync snapshot. Negative means rows were
    /// removed (e.g. listings closed eBay-side) which is also useful
    /// signal for the user.
    public let listingsDelta: Int
    public let salesDelta: Int

    public init(
        listingsCount: Int = 0,
        activeListingsCount: Int = 0,
        salesCount: Int = 0,
        listingsDelta: Int = 0,
        salesDelta: Int = 0
    ) {
        self.listingsCount = listingsCount
        self.activeListingsCount = activeListingsCount
        self.salesCount = salesCount
        self.listingsDelta = listingsDelta
        self.salesDelta = salesDelta
    }
}

/// Terminal state for a sync attempt.
public enum EbaySyncCompletion: Equatable {
    /// `last_synced_at` advanced past the pre-sync snapshot. The post-
    /// sync `SyncEngine.pull` has already refreshed the local cache, so
    /// the summary is computed against that fresh state.
    case completed(EbaySyncSummary)
    /// We polled the configured deadline and never saw `last_synced_at`
    /// advance. The job may still be running on the server; user can
    /// re-check in a minute.
    case timedOut
    /// The eBay refresh worker flagged the connection mid-sync (token
    /// expired, scope changed, etc.). Surface the message so the user
    /// can reconnect.
    case connectionFlagged(message: String)
    /// Network or HTTP failure either starting or polling the sync.
    case failed(message: String)
}

/// Pre-sync snapshot used to compute deltas after the pull finishes.
public struct EbaySyncBaseline: Equatable {
    public let listings: Int
    public let activeListings: Int
    public let sales: Int
    public let lastSyncedAt: String?

    public init(listings: Int, activeListings: Int, sales: Int, lastSyncedAt: String?) {
        self.listings = listings
        self.activeListings = activeListings
        self.sales = sales
        self.lastSyncedAt = lastSyncedAt
    }
}
