import Foundation

/// US-1866 — the read models for the Thrift Radar surface on iOS.
///
/// Two decoder conventions live side by side in this folder and mixing them up
/// silently returns nils. ``ProspectTypes`` decodes with a *plain* decoder
/// because the scout routes emit camelCase; the Radar routes
/// (`/api/flipdesk/radar/*`) emit **snake_case**, so everything here goes
/// through the shared ``EdgeAPI`` decoder, which converts snake → camel. That
/// also buys the US-1213 plan-gate interception for free — see ``RadarService``.
///
/// Timestamps stay `String`. The edge emits fractional seconds, which the
/// decoder's `.iso8601` date strategy rejects, and every timestamp Radar shows
/// is already served pre-computed as a whole number of days.
///
/// Every struct here carries an EXPLICIT memberwise init with defaults. These
/// are decode-only types, so a later field would otherwise break the synthesized
/// init at each test construction site — and Swift does not compile on the
/// Windows loop host, so that only fails on iOS CI.

// MARK: - Window

/// The activity windows the aggregation job publishes. Mirrors
/// `RADAR_WINDOWS` in `src/hooks/use-radar-network.ts`.
enum RadarWindow: String, CaseIterable, Identifiable, Sendable {
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case ninetyDays = "90d"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sevenDays: return "Last 7 days"
        case .thirtyDays: return "Last 30 days"
        case .ninetyDays: return "Last 90 days"
        }
    }

    /// Short form for a segmented control, where the long label does not fit.
    var shortLabel: String {
        switch self {
        case .sevenDays: return "7d"
        case .thirtyDays: return "30d"
        case .ninetyDays: return "90d"
        }
    }
}

// MARK: - Network layer

/// Condition mix at a venue. Counts, never a per-scan list.
struct RadarGradeMix: Decodable, Equatable, Sendable {
    let high: Int
    let mid: Int
    let low: Int
    let ungraded: Int

    init(high: Int = 0, mid: Int = 0, low: Int = 0, ungraded: Int = 0) {
        self.high = high
        self.mid = mid
        self.low = low
        self.ungraded = ungraded
    }

    /// Scans that carried a grade. Zero means there is no condition picture,
    /// which is a different statement from "everything found here was rough".
    var graded: Int { high + mid + low }
}

/// One served aggregate row: a venue's activity for one window and one brand
/// key (`brand == nil` is the venue total).
///
/// Nothing on this type can name, key or order a contributor — that is a
/// property of the endpoint (see the header of `routes/flipdesk-radar.ts`), and
/// the client's job is only to avoid inventing what the server withheld.
struct RadarNetworkStats: Decodable, Equatable, Sendable {
    let venueId: String
    let window: String
    /// Nil for the all-brands total.
    let brand: String?
    let scanCount: Int
    let contributorCount: Int
    let avgGrade: Double?
    let buyRate: Double?
    let gradeMix: RadarGradeMix
    /// Seven counts, index 0 = Sunday, in the venue's approximate local time.
    let activityByDay: [Int]
    let lastActivityAt: String?
    let daysSinceActivity: Int?

    init(
        venueId: String = "",
        window: String = RadarWindow.thirtyDays.rawValue,
        brand: String? = nil,
        scanCount: Int = 0,
        contributorCount: Int = 0,
        avgGrade: Double? = nil,
        buyRate: Double? = nil,
        gradeMix: RadarGradeMix = RadarGradeMix(),
        activityByDay: [Int] = [],
        lastActivityAt: String? = nil,
        daysSinceActivity: Int? = nil
    ) {
        self.venueId = venueId
        self.window = window
        self.brand = brand
        self.scanCount = scanCount
        self.contributorCount = contributorCount
        self.avgGrade = avgGrade
        self.buyRate = buyRate
        self.gradeMix = gradeMix
        self.activityByDay = activityByDay
        self.lastActivityAt = lastActivityAt
        self.daysSinceActivity = daysSinceActivity
    }
}

/// A venue as the list endpoint serves it. `lat`/`lng` are a geohash **cell
/// centre**, identical for everyone in that cell (US-1862) — so they place a
/// store on a list, and are not a record of where anybody stood.
struct RadarVenue: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let displayName: String
    let chain: String?
    let lat: Double
    let lng: Double
    let status: String
    let network: RadarNetworkStats

    init(
        id: String = "",
        displayName: String = "",
        chain: String? = nil,
        lat: Double = 0,
        lng: Double = 0,
        status: String = "active",
        network: RadarNetworkStats = RadarNetworkStats()
    ) {
        self.id = id
        self.displayName = displayName
        self.chain = chain
        self.lat = lat
        self.lng = lng
        self.status = status
        self.network = network
    }
}

struct RadarVenuesPayload: Decodable, Equatable, Sendable {
    let window: String
    let brand: String?
    /// How many different people must have scanned somewhere before it appears.
    let kFloor: Int
    let venues: [RadarVenue]

    init(
        window: String = RadarWindow.thirtyDays.rawValue,
        brand: String? = nil,
        kFloor: Int = 0,
        venues: [RadarVenue] = []
    ) {
        self.window = window
        self.brand = brand
        self.kFloor = kFloor
        self.venues = venues
    }
}

/// The venue half of the detail payload (no `network` — that is a sibling).
struct RadarVenueSummary: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let displayName: String
    let chain: String?
    let lat: Double
    let lng: Double
    let status: String

    init(
        id: String = "",
        displayName: String = "",
        chain: String? = nil,
        lat: Double = 0,
        lng: Double = 0,
        status: String = "active"
    ) {
        self.id = id
        self.displayName = displayName
        self.chain = chain
        self.lat = lat
        self.lng = lng
        self.status = status
    }
}

struct RadarVenueDetailPayload: Decodable, Equatable, Sendable {
    let window: String
    let kFloor: Int
    let venue: RadarVenueSummary
    let network: RadarNetworkStats
    /// Per-brand rows that individually cleared the floor, busiest first. A
    /// brand missing here is a brand we cannot speak about, not a brand absent
    /// from the store.
    let brands: [RadarNetworkStats]

    init(
        window: String = RadarWindow.thirtyDays.rawValue,
        kFloor: Int = 0,
        venue: RadarVenueSummary = RadarVenueSummary(),
        network: RadarNetworkStats = RadarNetworkStats(),
        brands: [RadarNetworkStats] = []
    ) {
        self.window = window
        self.kFloor = kFloor
        self.venue = venue
        self.network = network
        self.brands = brands
    }
}

// MARK: - Personal layer

struct RadarPersonalBrand: Decodable, Equatable, Sendable {
    let brand: String
    let items: Int
    let realizedProfitCents: Int

    init(brand: String = "", items: Int = 0, realizedProfitCents: Int = 0) {
        self.brand = brand
        self.items = items
        self.realizedProfitCents = realizedProfitCents
    }
}

/// One store out of the caller's OWN sourcing history (US-1864).
///
/// Free on every plan, needs no contribution consent, and works at n=1 — which
/// is why this is the layer everything degrades to when the network layer is
/// locked, empty or unreachable.
struct RadarPersonalStore: Decodable, Equatable, Sendable, Identifiable {
    let key: String
    let sourceId: String?
    let venueId: String?
    let name: String
    let sourceType: String?
    let location: String?
    let chain: String?
    /// Present only once the source has been linked to a place on the map.
    let lat: Double?
    let lng: Double?
    let linked: Bool
    let itemsSourced: Int
    let itemsSold: Int
    let spendCents: Int
    let soldSpendCents: Int
    let realizedProfitCents: Int
    let expectedProfitCents: Int
    let roiPct: Double?
    let realizedRoiPct: Double?
    let sellThroughPct: Double?
    let topBrands: [RadarPersonalBrand]
    let visits: Int
    let buyVisits: Int
    let lastVisitAt: String?
    let lastVisitSource: String?

    var id: String { key }

    /// Placeable on the nearby list: the registry knows where this store is.
    var point: RadarPoint? {
        guard let lat, let lng else { return nil }
        return RadarPoint(lat: lat, lng: lng)
    }

    init(
        key: String = "",
        sourceId: String? = nil,
        venueId: String? = nil,
        name: String = "",
        sourceType: String? = nil,
        location: String? = nil,
        chain: String? = nil,
        lat: Double? = nil,
        lng: Double? = nil,
        linked: Bool = false,
        itemsSourced: Int = 0,
        itemsSold: Int = 0,
        spendCents: Int = 0,
        soldSpendCents: Int = 0,
        realizedProfitCents: Int = 0,
        expectedProfitCents: Int = 0,
        roiPct: Double? = nil,
        realizedRoiPct: Double? = nil,
        sellThroughPct: Double? = nil,
        topBrands: [RadarPersonalBrand] = [],
        visits: Int = 0,
        buyVisits: Int = 0,
        lastVisitAt: String? = nil,
        lastVisitSource: String? = nil
    ) {
        self.key = key
        self.sourceId = sourceId
        self.venueId = venueId
        self.name = name
        self.sourceType = sourceType
        self.location = location
        self.chain = chain
        self.lat = lat
        self.lng = lng
        self.linked = linked
        self.itemsSourced = itemsSourced
        self.itemsSold = itemsSold
        self.spendCents = spendCents
        self.soldSpendCents = soldSpendCents
        self.realizedProfitCents = realizedProfitCents
        self.expectedProfitCents = expectedProfitCents
        self.roiPct = roiPct
        self.realizedRoiPct = realizedRoiPct
        self.sellThroughPct = sellThroughPct
        self.topBrands = topBrands
        self.visits = visits
        self.buyVisits = buyVisits
        self.lastVisitAt = lastVisitAt
        self.lastVisitSource = lastVisitSource
    }
}

struct RadarPersonalStoresPayload: Decodable, Equatable, Sendable {
    let sort: String
    let stores: [RadarPersonalStore]
    let unplacedVisits: Int
    let unattributedItems: Int
    let truncated: Bool

    init(
        sort: String = "roi",
        stores: [RadarPersonalStore] = [],
        unplacedVisits: Int = 0,
        unattributedItems: Int = 0,
        truncated: Bool = false
    ) {
        self.sort = sort
        self.stores = stores
        self.unplacedVisits = unplacedVisits
        self.unattributedItems = unattributedItems
        self.truncated = truncated
    }
}

// MARK: - Linking a source to a venue (US-3106)

/// `POST /api/flipdesk/radar/my-stores/link` body.
///
/// The wire keys are `source_id` and `venue_id`. They are spelled camelCase
/// here because the shared ``EdgeAPI`` encoder converts to snake_case on the
/// way out — the same convention every other Radar call uses in reverse on the
/// way in. Writing the snake_case spelling by hand would double-convert into
/// `source__id` and the route would answer "source_id is required" for a
/// request that plainly carries one.
struct RadarLinkRequest: Encodable, Equatable {
    let sourceId: String
    /// Nil unlinks. Absent and explicit null mean the same thing to the route,
    /// and the synthesized encoder omits the key, which is the absent case.
    let venueId: String?

    init(sourceId: String, venueId: String?) {
        self.sourceId = sourceId
        self.venueId = venueId
    }
}

struct RadarLinkResponse: Decodable, Equatable {
    let ok: Bool
    /// What the link now points at, or nil after an unlink.
    let venueId: String?

    init(ok: Bool = true, venueId: String? = nil) {
        self.ok = ok
        self.venueId = venueId
    }
}
