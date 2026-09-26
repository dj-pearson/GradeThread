import Foundation

/// Sort preset for the inventory list. Each option exposes a
/// `compare(_:_:)` so the same comparator can drive both the SwiftData
/// list query (sorting in memory after fetch) and the pure unit tests
/// in `InventoryFilterTests`.
public enum SortOption: String, CaseIterable, Identifiable, Hashable {
    case newest
    case oldest
    case bestROI       = "best_roi"
    case highestComp   = "highest_comp"
    case highestGrade  = "highest_grade"
    case skuNatural    = "sku_natural"
    // US-3124: who bought the item. The raw values match the web's `?sort=`
    // ids so a link and a phone mean the same order.
    case sourcerAZ     = "sourcer_az"
    case sourcerZA     = "sourcer_za"
    // US-3543: sales in the order they happened, and the work queue by how
    // long an item has sat untouched. Raw values match the web's `?sort=` ids.
    case recentSale    = "recent_sale"
    case oldestSale    = "oldest_sale"
    case untouchedLongest = "least_recently_updated"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .newest:       return "Newest added"
        case .oldest:       return "Oldest added"
        case .bestROI:      return "Best ROI"
        case .highestComp:  return "Highest comp"
        case .highestGrade: return "Highest grade"
        case .skuNatural:   return "SKU"
        case .sourcerAZ:    return "Sourced by A to Z"
        case .sourcerZA:    return "Sourced by Z to A"
        case .recentSale:   return "Most recent sale"
        case .oldestSale:   return "Oldest sale first"
        case .untouchedLongest: return "Untouched longest"
        }
    }

    public var systemImage: String {
        switch self {
        case .newest:       return "arrow.down.to.line"
        case .oldest:       return "arrow.up.to.line"
        case .bestROI:      return "chart.line.uptrend.xyaxis"
        case .highestComp:  return "dollarsign.arrow.circlepath"
        case .highestGrade: return "checkmark.seal"
        case .skuNatural:   return "barcode"
        case .sourcerAZ:    return "person"
        case .sourcerZA:    return "person"
        case .recentSale:   return "dollarsign.circle"
        case .oldestSale:   return "clock.arrow.circlepath"
        case .untouchedLongest: return "hourglass"
        }
    }

    /// US-3543: whether this sort reads the sale date. Only offered where
    /// sales live (All, Sold, Shipped, Returned).
    var isSaleSort: Bool { self == .recentSale || self == .oldestSale }

    /// Lower-comes-first comparator over LocalInventoryItem-like values.
    /// Returns true iff `a` should appear before `b` under this sort.
    ///
    /// - Parameter soldDates: item id -> linked sale date, for the two sale
    ///   sorts. The item row has no sold date of its own.
    func isOrdered(
        _ a: LocalInventoryItem,
        _ b: LocalInventoryItem,
        soldDates: [String: Date] = [:]
    ) -> Bool {
        switch self {
        case .recentSale, .oldestSale:
            // An item with no sale sinks in BOTH directions: it has not sold,
            // so it is neither the newest nor the oldest sale.
            let aDate = Self.saleDate(a, soldDates)
            let bDate = Self.saleDate(b, soldDates)
            switch (aDate, bDate) {
            case let (aDate?, bDate?) where aDate != bDate:
                return self == .recentSale ? aDate > bDate : aDate < bDate
            case (.some, .none): return true
            case (.none, .some): return false
            default:
                if a.createdAt != b.createdAt { return a.createdAt > b.createdAt }
                return a.id < b.id
            }
        case .untouchedLongest:
            if a.updatedAt != b.updatedAt { return a.updatedAt < b.updatedAt }
            return a.id < b.id
        case .newest:
            return a.createdAt > b.createdAt
        case .oldest:
            return a.createdAt < b.createdAt
        case .bestROI:
            // ROI proxy: (target_price - acquired_price) / acquired_price
            // Items missing either field sort to the bottom. Stable
            // ordering by createdAt as a tiebreaker.
            let aROI = SortOption.roi(target: a.targetPrice, cost: a.acquiredPrice)
            let bROI = SortOption.roi(target: b.targetPrice, cost: b.acquiredPrice)
            if aROI != bROI { return (aROI ?? -.greatestFiniteMagnitude) > (bROI ?? -.greatestFiniteMagnitude) }
            return a.createdAt > b.createdAt
        case .highestComp:
            // Closest standin we have on the local cache is target_price
            // — items_full's `comps` jsonb isn't cached locally yet.
            let aPrice = a.targetPrice ?? a.listingPrice ?? -.greatestFiniteMagnitude
            let bPrice = b.targetPrice ?? b.listingPrice ?? -.greatestFiniteMagnitude
            if aPrice != bPrice { return aPrice > bPrice }
            return a.createdAt > b.createdAt
        case .highestGrade:
            // Highest certified grade first; ungraded items sink to the
            // bottom (nil → -inf). Newest breaks ties so equal grades stay
            // stable and recent.
            let aGrade = a.gradeValue ?? -.greatestFiniteMagnitude
            let bGrade = b.gradeValue ?? -.greatestFiniteMagnitude
            if aGrade != bGrade { return aGrade > bGrade }
            return a.createdAt > b.createdAt
        case .skuNatural:
            return Self.naturalCompare(a.sku ?? "", b.sku ?? "") == .orderedAscending
        case .sourcerAZ, .sourcerZA:
            // Nobody recorded sorts LAST in BOTH directions — an item with no
            // sourcer is not "before A", it is unknown. Same rule the web's
            // NULLS LAST gives the table, and the same rule Android applies.
            let aName = a.sourcedBy?.facetTrimmed
            let bName = b.sourcedBy?.facetTrimmed
            if aName == nil || bName == nil {
                if aName == nil && bName == nil { return a.id < b.id }
                return bName == nil
            }
            let order = Self.naturalCompare(aName ?? "", bName ?? "")
            if order != .orderedSame {
                return self == .sourcerAZ
                    ? order == .orderedAscending
                    : order == .orderedDescending
            }
            // One person's items, newest first, with the id pinning ties so
            // the two clients cannot order the same list differently.
            if a.createdAt != b.createdAt { return a.createdAt > b.createdAt }
            return a.id < b.id
        }
    }

    /// Statuses an item only reaches by selling.
    static let soldStatuses: Set<String> = ["sold", "shipped", "completed", "returned"]

    /// The linked sale's date; for a sold item with no synced sale row (marked
    /// sold by hand), the last time the row changed, which is when it was
    /// marked. Nil for anything that has not sold.
    static func saleDate(_ item: LocalInventoryItem, _ soldDates: [String: Date]) -> Date? {
        if let date = soldDates[item.id] { return date }
        return soldStatuses.contains(item.status) ? item.updatedAt : nil
    }

    private static func roi(target: Double?, cost: Double?) -> Double? {
        guard let target, let cost, cost > 0 else { return nil }
        return (target - cost) / cost
    }

    /// Natural-order string comparison so 'S-2' comes before 'S-10'.
    /// Matches the web's `naturalCompare`. We diff numeric runs as
    /// whole integers + lowercase the alpha runs to mirror the web's
    /// case-insensitive collation.
    static func naturalCompare(_ left: String, _ right: String) -> ComparisonResult {
        let l = Array(left.lowercased())
        let r = Array(right.lowercased())
        var i = 0, j = 0
        while i < l.count, j < r.count {
            if l[i].isNumber, r[j].isNumber {
                var iEnd = i
                while iEnd < l.count, l[iEnd].isNumber { iEnd += 1 }
                var jEnd = j
                while jEnd < r.count, r[jEnd].isNumber { jEnd += 1 }
                let lNum = Int(String(l[i..<iEnd])) ?? 0
                let rNum = Int(String(r[j..<jEnd])) ?? 0
                if lNum != rNum { return lNum < rNum ? .orderedAscending : .orderedDescending }
                i = iEnd
                j = jEnd
            } else {
                if l[i] != r[j] { return l[i] < r[j] ? .orderedAscending : .orderedDescending }
                i += 1
                j += 1
            }
        }
        if i == l.count, j == r.count { return .orderedSame }
        return i == l.count ? .orderedAscending : .orderedDescending
    }
}
