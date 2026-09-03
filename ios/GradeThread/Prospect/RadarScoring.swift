import Foundation

/// US-1866 — the pure half of the iOS Thrift Radar surface.
///
/// A direct port of `src/lib/radar-map.ts`, minus the map projection: the phone
/// surface is a ranked LIST, not a canvas, so it needs the hotness, the brand
/// weighting, the freshness decay and the viewport maths, and none of the Web
/// Mercator arithmetic. Everything the two platforms both show is computed the
/// same way here as it is there — a store that reads "Busiest near you" on the
/// web must not read "Quiet" in the app for the same numbers.
///
/// No CoreLocation, no network, no SwiftUI: every function is a function of its
/// arguments, so the ranking is unit-tested directly rather than through a
/// rendered list (`RadarScoringTests`).

// MARK: - Geometry

/// A place on the ranked list — a venue's cell centre, or a linked store's.
///
/// Deliberately NOT ``RadarFix``. A fix is the user's own position, collected
/// under consent and held just long enough to send; a point is a published
/// coordinate the server already serves to everyone. Keeping them different
/// types stops the two from being swapped by accident.
struct RadarPoint: Equatable, Sendable {
    let lat: Double
    let lng: Double

    init(lat: Double, lng: Double) {
        self.lat = lat
        self.lng = lng
    }
}

/// The rectangle a `bbox=` query asks about.
struct RadarBoundingBox: Equatable, Sendable {
    let minLat: Double
    let minLng: Double
    let maxLat: Double
    let maxLng: Double

    /// `minLat,minLng,maxLat,maxLng`, rounded — the exact shape
    /// `parseBoundingBox` in `routes/flipdesk-radar.ts` parses.
    var param: String {
        let r = { (n: Double) in String(format: "%.4f", n) }
        return "\(r(minLat)),\(r(minLng)),\(r(maxLat)),\(r(maxLng))"
    }
}

enum RadarScoring {

    // MARK: - Viewport

    /// Mirrors `MAX_BBOX_DEGREES` in `routes/flipdesk-radar.ts`. A larger ask is
    /// a scrape, not a map, and the endpoint answers it with a 400.
    static let maxBoundingBoxDegrees: Double = 5

    /// How far "nearby" reaches by default. Wide enough to cover the stores on
    /// one sourcing run, narrow enough that the answer is about where the user
    /// actually is.
    static let defaultRadiusKm: Double = 25

    static func clamp(_ value: Double, _ lower: Double, _ upper: Double) -> Double {
        min(upper, max(lower, value))
    }

    /// A box around a point. `radiusKm` is a half-width, so the box is roughly
    /// 2×radius on a side.
    static func boundingBox(
        around centre: RadarPoint,
        radiusKm: Double = RadarScoring.defaultRadiusKm
    ) -> RadarBoundingBox {
        let latDelta = radiusKm / 111.0
        // Longitude degrees shrink toward the poles; without the cosine a box
        // at 60°N would be twice as wide on the ground as it is tall.
        let cosLat = max(0.05, cos(centre.lat * .pi / 180))
        let lngDelta = radiusKm / (111.0 * cosLat)
        return clampSpan(RadarBoundingBox(
            minLat: clamp(centre.lat - latDelta, -90, 90),
            minLng: clamp(centre.lng - lngDelta, -180, 180),
            maxLat: clamp(centre.lat + latDelta, -90, 90),
            maxLng: clamp(centre.lng + lngDelta, -180, 180)
        ))
    }

    /// A box covering every point, or nil when there are none.
    ///
    /// This is the cold-start path and the reason Radar opens without a
    /// permission prompt: a reseller's own linked stores are places we already
    /// know, so the list can be centred on them without asking iOS anything.
    static func boundingBox(
        covering points: [RadarPoint],
        paddingKm: Double = 8
    ) -> RadarBoundingBox? {
        guard let first = points.first else { return nil }
        var minLat = first.lat, maxLat = first.lat
        var minLng = first.lng, maxLng = first.lng
        for point in points.dropFirst() {
            minLat = min(minLat, point.lat)
            maxLat = max(maxLat, point.lat)
            minLng = min(minLng, point.lng)
            maxLng = max(maxLng, point.lng)
        }
        let centre = RadarPoint(lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2)
        let padLat = paddingKm / 111.0
        let padLng = paddingKm / (111.0 * max(0.05, cos(centre.lat * .pi / 180)))
        return clampSpan(RadarBoundingBox(
            minLat: clamp(minLat - padLat, -90, 90),
            minLng: clamp(minLng - padLng, -180, 180),
            maxLat: clamp(maxLat + padLat, -90, 90),
            maxLng: clamp(maxLng + padLng, -180, 180)
        ))
    }

    /// Shrink a box around its own centre until neither side exceeds the limit
    /// the endpoint enforces, so a wide ask returns less rather than 400ing.
    static func clampSpan(
        _ box: RadarBoundingBox,
        maxDegrees: Double = RadarScoring.maxBoundingBoxDegrees
    ) -> RadarBoundingBox {
        let latSpan = min(box.maxLat - box.minLat, maxDegrees)
        let lngSpan = min(box.maxLng - box.minLng, maxDegrees)
        let midLat = (box.minLat + box.maxLat) / 2
        let midLng = (box.minLng + box.maxLng) / 2
        return RadarBoundingBox(
            minLat: clamp(midLat - latSpan / 2, -90, 90),
            minLng: clamp(midLng - lngSpan / 2, -180, 180),
            maxLat: clamp(midLat + latSpan / 2, -90, 90),
            maxLng: clamp(midLng + lngSpan / 2, -180, 180)
        )
    }

    /// Snap a box onto a coarse grid.
    ///
    /// Two jobs, and the second is the important one: it keeps a small movement
    /// re-using the same query, AND it stops the sequence of requests from being
    /// a fine-grained trace of where the user is standing. The whole point of
    /// this feature's schema is that no precise position is stored; sending one
    /// four decimal places at a time in a query string would give it away by
    /// another route.
    static func quantize(_ box: RadarBoundingBox, step: Double = 0.05) -> RadarBoundingBox {
        guard step > 0 else { return box }
        return RadarBoundingBox(
            minLat: (box.minLat / step).rounded(.down) * step,
            minLng: (box.minLng / step).rounded(.down) * step,
            maxLat: (box.maxLat / step).rounded(.up) * step,
            maxLng: (box.maxLng / step).rounded(.up) * step
        )
    }

    /// Great-circle distance in kilometres. Used only to LABEL and to break
    /// ties on the list; the ranking itself is activity, not proximity.
    static func distanceKm(_ a: RadarPoint, _ b: RadarPoint) -> Double {
        let earthRadiusKm = 6371.0
        let dLat = (b.lat - a.lat) * .pi / 180
        let dLng = (b.lng - a.lng) * .pi / 180
        let lat1 = a.lat * .pi / 180
        let lat2 = b.lat * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2)
            + sin(dLng / 2) * sin(dLng / 2)
            * cos(lat1) * cos(lat2)
        return 2 * earthRadiusKm * asin(min(1, h.squareRoot()))
    }

    // MARK: - Brand weighting

    /// How many brands the weighting considers. Each one costs a request.
    static let maxWeightedBrands = 3

    /// Fold the reseller's per-store brand history into normalized weights.
    ///
    /// Ranked by item COUNT first and profit second, deliberately: how often a
    /// brand turns up in their pipeline is what predicts whether a store full of
    /// it is worth the walk in. One outsized flip should not redirect the whole
    /// list. Same rule, same order as `brandWeights` in `src/lib/radar-map.ts`.
    static func brandWeights(
        _ stores: [RadarPersonalStore],
        limit: Int = RadarScoring.maxWeightedBrands
    ) -> [RadarBrandWeight] {
        var totals: [String: (items: Int, profit: Int)] = [:]
        for store in stores {
            for entry in store.topBrands {
                let key = entry.brand.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard !key.isEmpty else { continue }
                var row = totals[key] ?? (items: 0, profit: 0)
                row.items += max(0, entry.items)
                row.profit += max(0, entry.realizedProfitCents)
                totals[key] = row
            }
        }

        let ranked = totals
            .filter { $0.value.items > 0 || $0.value.profit > 0 }
            .sorted { lhs, rhs in
                if lhs.value.items != rhs.value.items { return lhs.value.items > rhs.value.items }
                if lhs.value.profit != rhs.value.profit { return lhs.value.profit > rhs.value.profit }
                return lhs.key < rhs.key
            }
            .prefix(max(0, limit))

        let total = ranked.reduce(0) { $0 + max($1.value.items, 1) }
        guard total > 0 else { return [] }
        return ranked.map {
            RadarBrandWeight(brand: $0.key, weight: Double(max($0.value.items, 1)) / Double(total))
        }
    }

    // MARK: - Hotness

    /// How much a brand-matched scan is worth relative to an unmatched one.
    ///
    /// Weighting, not filtering. A store nobody has scanned your brands at can
    /// still be the busiest place in town, and dropping it would make the list
    /// lie about where the supply is.
    static let brandBoost: Double = 2

    /// Freshness decay. Stepped rather than continuous, because the underlying
    /// number is a whole day and a smooth curve would imply a resolution the
    /// data does not have. An unknown last-scan is treated as the OLDEST bucket:
    /// an unknown is not a recommendation.
    static func freshnessFactor(daysSince: Int?) -> Double {
        guard let daysSince else { return 0.3 }
        if daysSince <= 3 { return 1 }
        if daysSince <= 7 { return 0.75 }
        if daysSince <= 21 { return 0.5 }
        return 0.3
    }

    static func freshnessLabel(daysSince: Int?) -> String {
        guard let daysSince else { return "No recent activity" }
        if daysSince == 0 { return "Scanned today" }
        if daysSince == 1 { return "Scanned yesterday" }
        if daysSince <= 7 { return "Scanned \(daysSince) days ago" }
        if daysSince <= 14 { return "Scanned last week" }
        if daysSince <= 31 { return "Scanned this month" }
        return "Scanned over a month ago"
    }

    /// Unnormalized weight of one venue's activity, for this reseller.
    static func weightedActivity(
        _ activity: RadarVenueActivity,
        weights: [RadarBrandWeight]
    ) -> Double {
        var score = Double(max(0, activity.allScans))
        for weight in weights {
            let scans = activity.brandScans[weight.brand] ?? 0
            score += Double(max(0, scans)) * weight.weight * brandBoost
        }
        return score * freshnessFactor(daysSince: activity.daysSince)
    }

    /// 0…1 hotness, relative to the hottest venue currently listed.
    ///
    /// Relative on purpose: "hot" means "hotter than the rest of what you can
    /// see", which is the comparison a reseller planning a route actually makes.
    /// An absolute scale would paint a whole quiet region cold and say nothing
    /// about which of its stores to try.
    static func hotnessScore(
        _ activity: RadarVenueActivity,
        weights: [RadarBrandWeight],
        peak: Double
    ) -> Double {
        guard peak > 0 else { return 0 }
        return clamp(weightedActivity(activity, weights: weights) / peak, 0, 1)
    }

    static func hotnessLevel(_ score: Double) -> RadarHotnessLevel {
        if score >= 0.75 { return .peak }
        if score >= 0.45 { return .hot }
        if score >= 0.2 { return .warm }
        return .quiet
    }

    // MARK: - Day of week

    /// Index 0 = Sunday, matching the served `activity_by_day` array.
    static let dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    /// Turn the served week into bars, or nil when there is no pattern to show.
    ///
    /// An all-zero week is not "a store that is dead every day" — it is a row
    /// the aggregation job has not rewritten since the column existed. Returning
    /// nil lets the view say so instead of drawing seven empty bars that read as
    /// a finding.
    static func dayBars(_ counts: [Int]?) -> [RadarDayBar]? {
        guard let counts, !counts.isEmpty else { return nil }
        let week = dayLabels.enumerated().map { index, label in
            (label: label, count: max(0, index < counts.count ? counts[index] : 0))
        }
        let peak = week.map(\.count).max() ?? 0
        guard peak > 0 else { return nil }
        return week.map {
            RadarDayBar(
                label: $0.label,
                count: $0.count,
                share: Double($0.count) / Double(peak),
                busiest: $0.count == peak
            )
        }
    }

    /// One-line summary of the weekly pattern, or nil when there is no pattern.
    static func busiestDayLabel(_ counts: [Int]?) -> String? {
        guard let bars = dayBars(counts) else { return nil }
        let busiest = bars.filter(\.busiest)
        // Every day equal is not a pattern; naming one would invent it.
        if busiest.count >= dayLabels.count { return nil }
        if busiest.count > 2 { return nil }
        return busiest.map(\.label).joined(separator: " and ")
    }

    // MARK: - Ranking

    /// Order the list.
    ///
    /// Hotness first, so the answer to "is this store worth walking into?" is at
    /// the top; distance only breaks ties. Rows the network cannot speak about —
    /// the reseller's own stores below the k-floor, or that nobody else has been
    /// to — sort AFTER the scored ones but are never dropped: those are the
    /// places they actually go, and a list that hid them would be less useful
    /// than the one they had before Radar existed.
    static func rank(_ rows: [RadarNearbyRow]) -> [RadarNearbyRow] {
        rows.sorted { lhs, rhs in
            switch (lhs.score, rhs.score) {
            case let (l?, r?):
                if l != r { return l > r }
            case (.some, .none):
                return true
            case (.none, .some):
                return false
            case (.none, .none):
                break
            }
            switch (lhs.distanceKm, rhs.distanceKm) {
            case let (l?, r?):
                if l != r { return l < r }
            case (.some, .none):
                return true
            case (.none, .some):
                return false
            case (.none, .none):
                break
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }
}

// MARK: - Value types

/// How much a brand counts toward hotness, for one reseller. Derived from their
/// OWN pipeline history, which is why the weighting costs no AI spend and stores
/// no new preference.
struct RadarBrandWeight: Equatable, Sendable, Identifiable {
    let brand: String
    /// 0…1, summing to 1 across the list.
    let weight: Double

    var id: String { brand }

    init(brand: String, weight: Double) {
        self.brand = brand
        self.weight = weight
    }
}

/// The inputs the hotness score reads, folded from the venue total plus the
/// per-brand rows that cleared the floor.
struct RadarVenueActivity: Equatable, Sendable {
    let allScans: Int
    /// Per weighted brand key, when that brand's row cleared the floor. A brand
    /// missing here lands as a zero, which is the correct reading: not "no Nike
    /// here" but "nothing we can say about Nike here".
    var brandScans: [String: Int]
    let daysSince: Int?

    init(allScans: Int = 0, brandScans: [String: Int] = [:], daysSince: Int? = nil) {
        self.allScans = allScans
        self.brandScans = brandScans
        self.daysSince = daysSince
    }
}

enum RadarHotnessLevel: String, CaseIterable, Sendable {
    case quiet
    case warm
    case hot
    case peak

    var label: String {
        switch self {
        case .quiet: return "Quiet"
        case .warm: return "Some activity"
        case .hot: return "Busy"
        case .peak: return "Busiest near you"
        }
    }

}

struct RadarDayBar: Equatable, Sendable, Identifiable {
    let label: String
    let count: Int
    /// 0…1 against the busiest day, for the bar height.
    let share: Double
    let busiest: Bool

    var id: String { label }
}

/// One row of the nearby list: a venue, one of the reseller's own stores, or
/// both at once.
///
/// "Both at once" is the blend the story asks for — the question "have I done
/// well here before" and the question "are strangers busy here" are about the
/// same shop, and answering them in two separate lists would make the reader do
/// the join.
struct RadarNearbyRow: Equatable, Sendable, Identifiable {
    let id: String
    /// Nil for one of the reseller's own sources that is not linked to a place.
    let venueId: String?
    let name: String
    let chain: String?
    let distanceKm: Double?
    /// Nil when the network has nothing servable here — below the k-floor, or
    /// nobody else has been.
    let network: RadarNetworkStats?
    /// The reseller's own history at this store, when they have any.
    let personal: RadarPersonalStore?
    /// Nil for a row with no network data. NOT zero: zero would claim we looked
    /// and found it quiet.
    let score: Double?
    /// US-3106: where the row goes on the map. A geohash CELL CENTRE (US-1862),
    /// identical for everyone in that cell — it places a store, and is not a
    /// record of where anybody stood. Nil for one of the reseller's own sources
    /// that has never been linked to a place.
    let point: RadarPoint?

    var level: RadarHotnessLevel? { score.map(RadarScoring.hotnessLevel) }

    init(
        id: String,
        venueId: String? = nil,
        name: String,
        chain: String? = nil,
        distanceKm: Double? = nil,
        network: RadarNetworkStats? = nil,
        personal: RadarPersonalStore? = nil,
        score: Double? = nil,
        point: RadarPoint? = nil
    ) {
        self.id = id
        self.venueId = venueId
        self.name = name
        self.chain = chain
        self.distanceKm = distanceKm
        self.network = network
        self.personal = personal
        self.score = score
        self.point = point
    }
}
