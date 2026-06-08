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

    public var brands: Set<String> = []
    public var sizes: Set<String> = []
    public var colors: Set<String> = []
    /// US-676: storage location / bin multi-select.
    public var locationBins: Set<String> = []

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

    public init() {}

    public static let empty = InventoryFilterCriteria()

    /// True when any facet is narrowing the result set.
    public var isActive: Bool { self != .empty }

    /// Number of *distinct active facets* — drives the toolbar badge. A
    /// multi-select facet (e.g. three brands) counts once; a price band
    /// with either bound set counts once.
    public var activeCount: Int {
        var n = 0
        if !brands.isEmpty { n += 1 }
        if !sizes.isEmpty { n += 1 }
        if !colors.isEmpty { n += 1 }
        if !locationBins.isEmpty { n += 1 }
        if gradedOnly || minGrade != nil { n += 1 }
        if minPrice != nil || maxPrice != nil { n += 1 }
        if photoState != .any { n += 1 }
        if dateAdded != .any { n += 1 }
        return n
    }
}
