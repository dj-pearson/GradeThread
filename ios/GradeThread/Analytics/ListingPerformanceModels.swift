import Foundation

/// US-1128 — iOS parity for the web Listing Performance dashboard
/// (`src/pages/flipdesk/listing-performance.tsx`). One row per active eBay
/// listing with the engagement metrics eBay's Sell Analytics (getTrafficReport)
/// pushes onto `listings` every 6h: views, watchers, 7-day impressions, and
/// click-through-rate. Decoded from the `listings` table via the RLS-scoped
/// supabase client (no `convertFromSnakeCase` on the PostgREST decoder — keys
/// are mapped explicitly, mirroring ``RemoteMarketplaceConnection``).
struct ListingPerformanceRow: Decodable, Identifiable, Equatable {
    let id: String
    let inventoryItemId: String
    let listingTitle: String?
    let listingURL: String?
    let listingPrice: Double
    /// Kept as `String` (not `Date`): the edge emits fractional-second
    /// timestamps the default ISO date strategy rejects — parsed at the display
    /// boundary via ``daysListed(_:now:)``.
    let listedAt: String?
    let viewsTotal: Int
    let watchersCount: Int
    let impressions7d: Int
    let clickThroughRate: Double?
    let lastMetricsSyncedAt: String?
    let viewTrend7d: [TrendPoint]

    /// A single day in the rolling 7-day view trend (jsonb on `listings`).
    struct TrendPoint: Decodable, Equatable {
        let date: String
        let views: Int
    }

    enum CodingKeys: String, CodingKey {
        case id
        case inventoryItemId = "inventory_item_id"
        case listingTitle = "listing_title"
        case listingURL = "listing_url"
        case listingPrice = "listing_price"
        case listedAt = "listed_at"
        case viewsTotal = "views_total"
        case watchersCount = "watchers_count"
        case impressions7d = "impressions_7d"
        case clickThroughRate = "click_through_rate"
        case lastMetricsSyncedAt = "last_metrics_synced_at"
        case viewTrend7d = "view_trend_7d"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        inventoryItemId = try c.decode(String.self, forKey: .inventoryItemId)
        listingTitle = try c.decodeIfPresent(String.self, forKey: .listingTitle)
        listingURL = try c.decodeIfPresent(String.self, forKey: .listingURL)
        listingPrice = (try? c.decode(Double.self, forKey: .listingPrice)) ?? 0
        listedAt = try c.decodeIfPresent(String.self, forKey: .listedAt)
        // Tolerate nulls on rows synced before a metrics pull ran.
        viewsTotal = (try? c.decodeIfPresent(Int.self, forKey: .viewsTotal) ?? 0) ?? 0
        watchersCount = (try? c.decodeIfPresent(Int.self, forKey: .watchersCount) ?? 0) ?? 0
        impressions7d = (try? c.decodeIfPresent(Int.self, forKey: .impressions7d) ?? 0) ?? 0
        clickThroughRate = try c.decodeIfPresent(Double.self, forKey: .clickThroughRate)
        lastMetricsSyncedAt = try c.decodeIfPresent(String.self, forKey: .lastMetricsSyncedAt)
        viewTrend7d = (try? c.decodeIfPresent([TrendPoint].self, forKey: .viewTrend7d) ?? []) ?? []
    }

    /// Memberwise initializer for previews/tests (the `Decodable` init shadows
    /// the synthesized one).
    init(
        id: String,
        inventoryItemId: String,
        listingTitle: String? = nil,
        listingURL: String? = nil,
        listingPrice: Double = 0,
        listedAt: String? = nil,
        viewsTotal: Int = 0,
        watchersCount: Int = 0,
        impressions7d: Int = 0,
        clickThroughRate: Double? = nil,
        lastMetricsSyncedAt: String? = nil,
        viewTrend7d: [TrendPoint] = []
    ) {
        self.id = id
        self.inventoryItemId = inventoryItemId
        self.listingTitle = listingTitle
        self.listingURL = listingURL
        self.listingPrice = listingPrice
        self.listedAt = listedAt
        self.viewsTotal = viewsTotal
        self.watchersCount = watchersCount
        self.impressions7d = impressions7d
        self.clickThroughRate = clickThroughRate
        self.lastMetricsSyncedAt = lastMetricsSyncedAt
        self.viewTrend7d = viewTrend7d
    }
}

/// Column the listing-performance list sorts on. Mirrors the web page's
/// sortable headers (`SortKey`).
enum ListingPerformanceSort: String, CaseIterable, Identifiable {
    case views
    case watchers
    case impressions
    case ctr
    case daysListed
    case title

    var id: String { rawValue }

    var label: String {
        switch self {
        case .views: return "Views"
        case .watchers: return "Watchers"
        case .impressions: return "Impressions (7d)"
        case .ctr: return "Click-through"
        case .daysListed: return "Days listed"
        case .title: return "Title"
        }
    }

    /// Text sorts read better ascending; metrics default highest-first — the
    /// same default the web page applies on a header switch.
    var defaultAscending: Bool { self == .title }
}

/// Pure sort/filter/derive helpers shared by the view and unit tests (no
/// SwiftUI, no network) — mirrors the web page's `rows` memo.
enum ListingPerformance {
    /// `[7, 14, 30]` — the "no views in N days" filter windows (web `NO_VIEW_WINDOWS`).
    static let noViewWindows = [7, 14, 30]

    private static let isoFull: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    static func parseDate(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return isoFull.date(from: s) ?? isoPlain.date(from: s)
    }

    /// Whole days since the listing went live (0 when unknown). Mirrors web
    /// `daysListed`.
    static func daysListed(_ iso: String?, now: Date = .now) -> Int {
        guard let date = parseDate(iso) else { return 0 }
        return max(0, Int((now.timeIntervalSince(date)) / 86_400))
    }

    /// A listing is "stale" when it's accrued zero views after two weeks live —
    /// the web page badges its view count red.
    static func isStale(_ row: ListingPerformanceRow, now: Date = .now) -> Bool {
        row.viewsTotal == 0 && daysListed(row.listedAt, now: now) >= 14
    }

    /// Sort key used by ``sorted(_:by:ascending:now:)`` — extracted so the
    /// numeric/text branch is testable in isolation.
    static func sortValue(_ row: ListingPerformanceRow, _ sort: ListingPerformanceSort, now: Date) -> Double {
        switch sort {
        case .views: return Double(row.viewsTotal)
        case .watchers: return Double(row.watchersCount)
        case .impressions: return Double(row.impressions7d)
        // A nil CTR sorts below any real value (web uses -1).
        case .ctr: return row.clickThroughRate ?? -1
        case .daysListed: return Double(daysListed(row.listedAt, now: now))
        case .title: return 0
        }
    }

    /// Filters (zero-view, aged ≥ `minDays`) then sorts. `nil` `minDays` skips
    /// the no-view filter (chip off). Stable per the web memo.
    static func resolve(
        _ rows: [ListingPerformanceRow],
        sort: ListingPerformanceSort,
        ascending: Bool,
        minNoViewDays: Int? = nil,
        titleFor: (ListingPerformanceRow) -> String,
        now: Date = .now
    ) -> [ListingPerformanceRow] {
        let filtered: [ListingPerformanceRow]
        if let minNoViewDays {
            filtered = rows.filter {
                $0.viewsTotal == 0 && daysListed($0.listedAt, now: now) >= minNoViewDays
            }
        } else {
            filtered = rows
        }

        return filtered.sorted { a, b in
            if sort == .title {
                let av = titleFor(a).lowercased()
                let bv = titleFor(b).lowercased()
                if av == bv { return false }
                return ascending ? av < bv : av > bv
            }
            let av = sortValue(a, sort, now: now)
            let bv = sortValue(b, sort, now: now)
            if av == bv { return false }
            return ascending ? av < bv : av > bv
        }
    }
}
