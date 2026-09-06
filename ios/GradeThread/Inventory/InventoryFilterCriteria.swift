import Foundation

/// Multi-facet filter state for the inventory list. Distinct from
/// ``InventoryStage`` (the top-level status tabs) and ``SortOption`` — this
/// is the "narrow a big pile down" layer that resellers with thousands of
/// items need: brand / size / color multi-select, a price band, a grade
/// floor, photo-completeness, and a recency window.
///
/// `Codable` so it can be persisted as a named ``SavedFilter`` view. Pure
/// value type with no SwiftUI dependency so the matching logic lives in
/// ``InventoryFilter`` and is unit-testable.
public struct InventoryFilterCriteria: Codable, Equatable, Hashable {

    /// Recency window over `createdAt`. Mirrors the "added in the last N
    /// days" quick filters resellers reach for when triaging a fresh haul.
    public enum DatePreset: String, Codable, CaseIterable, Identifiable, Hashable {
        case any
        case last7
        case last30
        case last90

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .any:    return "Any time"
            case .last7:  return "Last 7 days"
            case .last30: return "Last 30 days"
            case .last90: return "Last 90 days"
            }
        }

        /// Number of days back from "now" the window spans, or nil for `any`.
        var days: Int? {
            switch self {
            case .any:    return nil
            case .last7:  return 7
            case .last30: return 30
            case .last90: return 90
            }
        }
    }

    /// Photo-completeness facet. `nil`/`.any` keeps everything; the others
    /// split on whether the row has a cached primary photo URL.
    public enum PhotoState: String, Codable, CaseIterable, Identifiable, Hashable {
        case any
        case withPhoto
        case missingPhoto

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .any:          return "Any"
            case .withPhoto:    return "With photo"
            case .missingPhoto: return "Missing photo"
            }
        }
    }

    /// An explicit from/to date window (US-1052). Unlike ``DatePreset`` (a
    /// fixed "last N days" relative to now), this is an absolute calendar
    /// range the user dials in — needed for the purchase/sale date facets web
    /// has and iOS was missing. Either bound may be nil (open-ended).
    public struct DateBand: Codable, Equatable, Hashable {
        public var from: Date?
        public var to: Date?

        public init(from: Date? = nil, to: Date? = nil) {
            self.from = from
            self.to = to
        }

        public var isActive: Bool { from != nil || to != nil }

        /// True when `date` falls inside the band. The `to` bound is treated
        /// as inclusive of the whole day so "to June 18" includes June 18.
        public func contains(_ date: Date) -> Bool {
            if let from, date < from { return false }
            if let to, date > to.addingTimeInterval(86_400 - 1) { return false }
            return true
        }
    }

    public var brands: Set<String> = []
    public var sizes: Set<String> = []
    public var colors: Set<String> = []
    /// US-676: storage location / bin multi-select.
    public var locationBins: Set<String> = []
    /// US-1052: acquisition `sources.id` multi-select (display name resolved
    /// from the local source cache in the UI layer).
    public var sources: Set<String> = []
    /// US-1052: `inventory_items.item_category` multi-select.
    public var categories: Set<String> = []
    /// US-3124: `inventory_items.sourced_by` multi-select — WHO bought the
    /// item, selected by name. ``sources`` is WHERE it came from and keys on
    /// an id; these are two different questions on two different columns.
    public var sourcers: Set<String> = []

    /// Only items carrying a certified grade.
    public var gradedOnly: Bool = false
    /// Minimum certified grade (1.0–10.0). Implies `gradedOnly` when set —
    /// an ungraded item can't clear a numeric floor.
    public var minGrade: Double?

    /// Price band, evaluated against the row's effective price
    /// (listing → target → acquired, see ``InventoryFilter/effectivePrice``).
    public var minPrice: Double?
    public var maxPrice: Double?

    public var photoState: PhotoState = .any
    public var dateAdded: DatePreset = .any

    /// US-1052: absolute purchase-date window (evaluated against the item's
    /// `createdAt`, the local acquisition proxy) and sale-date window
    /// (evaluated against the linked sale's date, resolved by the caller).
    public var purchaseDates: DateBand = DateBand()
    public var saleDates: DateBand = DateBand()

    /// US-1052: advanced AND/OR rule builder layered on top of the facets.
    public var ruleQuery: InventoryRuleQuery = .empty

    public init() {}

    public static let empty = InventoryFilterCriteria()

    /// True when any facet is narrowing the result set.
    public var isActive: Bool { self != .empty }

    /// Number of *distinct active facets* — drives the toolbar badge. A
    /// multi-select facet (e.g. three brands) counts once; a price band
    /// with either bound set counts once; the advanced rule builder counts
    /// once regardless of how many rules it holds.
    public var activeCount: Int {
        var n = 0
        if !brands.isEmpty { n += 1 }
        if !sizes.isEmpty { n += 1 }
        if !colors.isEmpty { n += 1 }
        if !locationBins.isEmpty { n += 1 }
        if !sources.isEmpty { n += 1 }
        if !categories.isEmpty { n += 1 }
        if !sourcers.isEmpty { n += 1 }
        if gradedOnly || minGrade != nil { n += 1 }
        if minPrice != nil || maxPrice != nil { n += 1 }
        if photoState != .any { n += 1 }
        if dateAdded != .any { n += 1 }
        if purchaseDates.isActive { n += 1 }
        if saleDates.isActive { n += 1 }
        if ruleQuery.isActive { n += 1 }
        return n
    }
}

// MARK: - Tolerant Codable (saved-view forward/backward compatibility)

extension InventoryFilterCriteria {
    private enum CodingKeys: String, CodingKey {
        case brands, sizes, colors, locationBins, sources, categories, sourcers
        case gradedOnly, minGrade, minPrice, maxPrice
        case photoState, dateAdded
        case purchaseDates, saleDates, ruleQuery
    }

    /// Decodes every field via `decodeIfPresent`, falling back to the property
    /// default when a key is missing. This is what lets a ``SavedFilter``
    /// persisted before US-1052 (which has none of the new keys) still decode
    /// — without it, ``SavedFilterStore`` would drop the entire saved list on
    /// upgrade because its loader fails the whole array on any decode error.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        brands = try c.decodeIfPresent(Set<String>.self, forKey: .brands) ?? []
        sizes = try c.decodeIfPresent(Set<String>.self, forKey: .sizes) ?? []
        colors = try c.decodeIfPresent(Set<String>.self, forKey: .colors) ?? []
        locationBins = try c.decodeIfPresent(Set<String>.self, forKey: .locationBins) ?? []
        sources = try c.decodeIfPresent(Set<String>.self, forKey: .sources) ?? []
        categories = try c.decodeIfPresent(Set<String>.self, forKey: .categories) ?? []
        sourcers = try c.decodeIfPresent(Set<String>.self, forKey: .sourcers) ?? []
        gradedOnly = try c.decodeIfPresent(Bool.self, forKey: .gradedOnly) ?? false
        minGrade = try c.decodeIfPresent(Double.self, forKey: .minGrade)
        minPrice = try c.decodeIfPresent(Double.self, forKey: .minPrice)
        maxPrice = try c.decodeIfPresent(Double.self, forKey: .maxPrice)
        photoState = try c.decodeIfPresent(PhotoState.self, forKey: .photoState) ?? .any
        dateAdded = try c.decodeIfPresent(DatePreset.self, forKey: .dateAdded) ?? .any
        purchaseDates = try c.decodeIfPresent(DateBand.self, forKey: .purchaseDates) ?? DateBand()
        saleDates = try c.decodeIfPresent(DateBand.self, forKey: .saleDates) ?? DateBand()
        ruleQuery = try c.decodeIfPresent(InventoryRuleQuery.self, forKey: .ruleQuery) ?? .empty
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(brands, forKey: .brands)
        try c.encode(sizes, forKey: .sizes)
        try c.encode(colors, forKey: .colors)
        try c.encode(locationBins, forKey: .locationBins)
        try c.encode(sources, forKey: .sources)
        try c.encode(categories, forKey: .categories)
        try c.encode(sourcers, forKey: .sourcers)
        try c.encode(gradedOnly, forKey: .gradedOnly)
        try c.encodeIfPresent(minGrade, forKey: .minGrade)
        try c.encodeIfPresent(minPrice, forKey: .minPrice)
        try c.encodeIfPresent(maxPrice, forKey: .maxPrice)
        try c.encode(photoState, forKey: .photoState)
        try c.encode(dateAdded, forKey: .dateAdded)
        try c.encode(purchaseDates, forKey: .purchaseDates)
        try c.encode(saleDates, forKey: .saleDates)
        try c.encode(ruleQuery, forKey: .ruleQuery)
    }
}
