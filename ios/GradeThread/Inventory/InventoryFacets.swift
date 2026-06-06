import Foundation

/// Distinct facet values present in the current inventory cache, with the
/// number of items behind each. The filter sheet offers only values that
/// actually exist (no empty "Color: Chartreuse" option), and shows counts
/// so the user can see how big a cut each value makes.
///
/// Pure derivation over a `[LocalInventoryItem]` snapshot — recomputed when
/// the sheet opens, never on every list render.
public struct InventoryFacets: Equatable {

    /// A selectable facet value plus how many items carry it.
    public struct Value: Identifiable, Hashable {
        public let value: String   // trimmed, original casing (display + key)
        public let count: Int
        public var id: String { value }
    }

    public let brands: [Value]
    public let sizes: [Value]
    public let colors: [Value]

    /// Effective-price span across items that have any price, or nil when
    /// none do. Used to seed the price-band slider bounds.
    public let priceBounds: ClosedRange<Double>?

    public static let empty = InventoryFacets(
        brands: [], sizes: [], colors: [], priceBounds: nil
    )

    /// Builds the facet index from a snapshot of items. Values are trimmed;
    /// blank/whitespace values are dropped. Brands/colors sort by frequency
    /// (most common first) then alphabetically; sizes sort naturally so
    /// "S, M, L, XL, 2, 10" land in a sane order rather than lexical.
    public static func derive(from items: [LocalInventoryItem]) -> InventoryFacets {
        var brandCounts: [String: Int] = [:]
        var sizeCounts: [String: Int] = [:]
        var colorCounts: [String: Int] = [:]
        var minPrice: Double?
        var maxPrice: Double?

        for item in items {
            if let b = item.brand?.facetTrimmed { brandCounts[b, default: 0] += 1 }
            if let s = item.size?.facetTrimmed { sizeCounts[s, default: 0] += 1 }
            if let c = item.color?.facetTrimmed { colorCounts[c, default: 0] += 1 }
            if let p = InventoryFilter.effectivePrice(item) {
                minPrice = min(minPrice ?? p, p)
                maxPrice = max(maxPrice ?? p, p)
            }
        }

        let bounds: ClosedRange<Double>?
        if let lo = minPrice, let hi = maxPrice {
            // Guard against a degenerate single-value range, which would
            // make a Slider crash on `lo...lo` being empty when lo == hi.
            bounds = lo < hi ? lo...hi : lo...(lo + 1)
        } else {
            bounds = nil
        }

        return InventoryFacets(
            brands: byFrequency(brandCounts),
            sizes: bySizeOrder(sizeCounts),
            colors: byFrequency(colorCounts),
            priceBounds: bounds
        )
    }

    // MARK: - Ordering

    private static func byFrequency(_ counts: [String: Int]) -> [Value] {
        counts
            .map { Value(value: $0.key, count: $0.value) }
            .sorted { lhs, rhs in
                if lhs.count != rhs.count { return lhs.count > rhs.count }
                return lhs.value.localizedCaseInsensitiveCompare(rhs.value) == .orderedAscending
            }
    }

    private static func bySizeOrder(_ counts: [String: Int]) -> [Value] {
        counts
            .map { Value(value: $0.key, count: $0.value) }
            .sorted { lhs, rhs in
                let l = SizeOrder.rank(lhs.value)
                let r = SizeOrder.rank(rhs.value)
                if l != r { return l < r }
                // Same bucket (e.g. two numeric sizes) → natural compare.
                return SortOption.naturalCompare(lhs.value, rhs.value) == .orderedAscending
            }
    }
}

/// Canonical ordering for apparel sizes so the size facet reads
/// XS → S → M → L → XL → XXL before falling back to numeric/natural order
/// for anything unrecognized (waist sizes, EU shoe sizes, "OS", etc.).
enum SizeOrder {
    private static let table: [String: Int] = [
        "xxs": 0, "xs": 1, "s": 2, "small": 2,
        "m": 3, "medium": 3, "l": 4, "large": 4,
        "xl": 5, "xxl": 6, "2xl": 6, "xxxl": 7, "3xl": 7,
    ]

    /// Lower rank sorts first. Lettered sizes occupy 0–7; everything else
    /// shares rank 100 and is disambiguated by natural compare.
    static func rank(_ raw: String) -> Int {
        table[raw.lowercased()] ?? 100
    }
}

extension String {
    /// Trimmed value for facet grouping, or nil if blank. Kept distinct from
    /// the row-display `nonEmpty` helper so facet semantics are explicit.
    var facetTrimmed: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
