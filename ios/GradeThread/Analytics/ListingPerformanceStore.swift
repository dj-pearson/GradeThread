import Foundation
import Observation
import Supabase

/// Fetches the per-listing performance data + the connection's analytics-scope
/// state. Behind a protocol so ``ListingPerformanceStore`` is unit-testable
/// with a fake (no network), mirroring ``EbayConnectionsProviding``.
@MainActor
protocol ListingPerformanceProviding {
    /// Active eBay listings with their engagement metrics, RLS-scoped to the
    /// signed-in user.
    func fetchRows() async throws -> [ListingPerformanceRow]
    /// Whether eBay denied Sell Analytics scope for the active connection
    /// (`marketplace_connections.analytics_access_denied`). `nil` = no active
    /// eBay connection at all.
    func fetchAnalyticsDenied() async throws -> Bool?
}

/// Supabase-backed implementation. Reads `listings` + `marketplace_connections`
/// directly via the RLS-scoped client — same source the web page uses
/// (`useEbayConnection` + the `listings` query) — so no dedicated edge route is
/// needed just to answer "how are my listings doing?".
@MainActor
struct ListingPerformanceService: ListingPerformanceProviding {
    private let supabase: SupabaseClient

    init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    private static let columns =
        "id, inventory_item_id, listing_title, listing_url, listing_price, listed_at, "
        + "views_total, watchers_count, impressions_7d, click_through_rate, "
        + "last_metrics_synced_at, view_trend_7d"

    func fetchRows() async throws -> [ListingPerformanceRow] {
        try await supabase
            .from("listings")
            .select(Self.columns)
            .eq("platform", value: "ebay")
            .eq("listing_status", value: "active")
            .order("views_total", ascending: false)
            .limit(1000)
            .execute()
            .value
    }

    func fetchAnalyticsDenied() async throws -> Bool? {
        struct Row: Decodable { let analytics_access_denied: Bool? }
        let rows: [Row] = try await supabase
            .from("marketplace_connections")
            .select("analytics_access_denied")
            .eq("marketplace", value: "ebay")
            .eq("is_active", value: true)
            .order("updated_at", ascending: false)
            .limit(1)
            .execute()
            .value
        guard let first = rows.first else { return nil }
        return first.analytics_access_denied ?? false
    }
}

/// Drives ``ListingPerformanceView``. Loads the listings + analytics-scope
/// state in parallel and exposes a small phase machine (loading / loaded /
/// failed) so the view can render loading, empty, error, and graceful-
/// degradation (reconnect prompt) states — parity with the web page.
@MainActor
@Observable
final class ListingPerformanceStore {
    enum Phase: Equatable {
        case loading
        case loaded([ListingPerformanceRow])
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    /// eBay hasn't granted Sell Analytics scope — show the reconnect prompt and
    /// degrade gracefully (metrics may be empty/zero). Mirrors the web banner.
    private(set) var analyticsDenied = false
    /// Latest `last_metrics_synced_at` across all rows (for the "Synced …" cue).
    private(set) var lastSyncedAt: Date?

    private let service: ListingPerformanceProviding

    init(service: ListingPerformanceProviding = ListingPerformanceService()) {
        self.service = service
    }

    func load() async {
        phase = .loading
        do {
            // Rows are the primary content — load them first; a failure here
            // fails the screen (retryable via ``ErrorStateView``).
            let rows = try await service.fetchRows()
            // The analytics-scope flag is secondary: a connection lookup failure
            // must NOT fail the whole screen, so degrade it to false. (`try?`
            // flattens the `Bool?` return — a thrown error and a no-connection
            // result both collapse to false.)
            let denied: Bool = (try? await service.fetchAnalyticsDenied()) ?? false

            analyticsDenied = denied
            lastSyncedAt = rows
                .compactMap { ListingPerformance.parseDate($0.lastMetricsSyncedAt) }
                .max()
            phase = .loaded(rows)
        } catch {
            Telemetry.breadcrumb(
                "listing performance load failed: \(error.localizedDescription)",
                category: "analytics"
            )
            phase = .failed(
                FriendlyErrorCopy.actionMessage(
                    for: error, fallback: "Couldn't load listing performance."))
        }
    }
}
