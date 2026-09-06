import Foundation

/// Distinct facet values present in the current inventory cache, with the
/// number of items behind each. The filter sheet offers only values that
/// actually exist (no empty "Color: Chartreuse" option), and shows counts
/// so the user can see how big a cut each value makes.
///
/// Pure derivation over a `[LocalInventoryItem]` snapshot — recomputed when
/// the sheet opens, never on every list render.
public struct InventoryFacets: Equatable {

    /// A selectable facet value plus how many items carry it. `value` is the
    /// stable filter key (the raw cell value, or an id for source); `label`
    /// is what the user reads — for most facets they're identical, but the
    /// source facet keys on `sources.id` while labelling with the source name.
    public struct Value: Identifiable, Hashable {
        public let value: String   // trimmed key (filter selection)
        public let label: String   // display text
        public let count: Int
        public var id: String { value }

        public init(value: String, label: String? = nil, count: Int) {
            self.value = value
            self.label = label ?? value
            self.count = count
        }
    }

    public let brands: [Value]
    public let sizes: [Value]
    public let colors: [Value]
    /// US-676: storage location / bin facet.
    public let locationBins: [Value]
    /// US-1052: acquisition source facet — keyed by `sources.id`, labelled
    /// with the resolved source name.
    public let sources: [Value]
    /// US-1052: item-category facet (clothing / shoes / watches / …).
    public let categories: [Value]
    /// US-3124: WHO bought the item — `inventory_items.sourced_by`, which is a
    /// NAME string on every platform (the roster picks it, it does not replace
    /// it). Keyed and labelled by that name, unlike ``sources``, which keys on
    /// an id. The two are different questions and sit next to each other.
    public let sourcers: [Value]

    /// Effective-price span across items that have any price, or nil when
    /// none do. Used to seed the price-band slider bounds.
    public let priceBounds: ClosedRange<Double>?

    /// US-1247: how many items in the snapshot carry NO effective price. The
    /// price band excludes these from `priceBounds` (an unknown price has no
    /// place on the slider), but a `maxPrice`-only filter deliberately KEEPS
    /// them (see ``InventoryFilter/matches``). Surfacing the count lets the
    /// filter UI explain that an unpriced backlog stays reachable under a
    /// ceiling-only band rather than silently vanishing.
    public let unpricedCount: Int

    public static let empty = InventoryFacets(
        brands: [], sizes: [], colors: [], locationBins: [],
        sources: [], categories: [], sourcers: [], priceBounds: nil, unpricedCount: 0
    )

    /// Builds the facet index from a snapshot of items. Values are trimmed;
    /// blank/whitespace values are dropped. Brands/colors sort by frequency
    /// (most common first) then alphabetically; sizes sort naturally so
    /// "S, M, L, XL, 2, 10" land in a sane order rather than lexical.
    ///
    /// Intentionally `internal` (not `public`): its parameter is the
    /// module-internal `LocalInventoryItem` model, and a `public` signature
    /// exposing an internal type doesn't compile. All callers (the list view
    /// and the `@testable` tests) live in this module.
    /// - Parameter sourceNames: maps `sources.id` → display name so the source
    ///   facet can show "Goodwill" instead of a raw UUID. Items whose
    ///   `sourceId` isn't in the map are still counted (labelled by the id) so
    ///   the facet never silently swallows them.
    static func derive(
        from items: [LocalInventoryItem],
        sourceNames: [String: String] = [:]
    ) -> InventoryFacets {
        var brandCounts: [String: Int] = [:]
        var sizeCounts: [String: Int] = [:]
        var colorCounts: [String: Int] = [:]
        var locationCounts: [String: Int] = [:]
        var sourceCounts: [String: Int] = [:]
        var categoryCounts: [String: Int] = [:]
        var sourcerCounts: [String: Int] = [:]
        var minPrice: Double?
        var maxPrice: Double?
        var unpricedCount = 0

        for item in items {
            if let b = item.brand?.facetTrimmed { brandCounts[b, default: 0] += 1 }
            if let s = item.size?.facetTrimmed { sizeCounts[s, default: 0] += 1 }
            if let c = item.color?.facetTrimmed { colorCounts[c, default: 0] += 1 }
            if let l = item.locationBin?.facetTrimmed { locationCounts[l, default: 0] += 1 }
            if let src = item.sourceId?.facetTrimmed { sourceCounts[src, default: 0] += 1 }
            if let cat = item.itemCategory?.facetTrimmed { categoryCounts[cat, default: 0] += 1 }
            if let who = item.sourcedBy?.facetTrimmed { sourcerCounts[who, default: 0] += 1 }
            if let p = InventoryFilter.effectivePrice(item) {
                minPrice = min(minPrice ?? p, p)
                maxPrice = max(maxPrice ?? p, p)
            } else {
                unpricedCount += 1
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
            locationBins: byFrequency(locationCounts),
            sources: byFrequency(sourceCounts) { sourceNames[$0] ?? $0 },
            categories: byFrequency(categoryCounts, label: Self.categoryLabel),
            sourcers: byFrequency(sourcerCounts),
            priceBounds: bounds,
            unpricedCount: unpricedCount
        )
    }

    /// Prettifies a raw `item_category` enum value ("sports_cards" → "Sports
    /// Cards") for display while keeping the raw value as the filter key.
    static func categoryLabel(_ raw: String) -> String {
        raw
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    // MARK: - Ordering

    private static func byFrequency(
        _ counts: [String: Int],
        label: (String) -> String = { $0 }
    ) -> [Value] {
        counts
            .map { Value(value: $0.key, label: label($0.key), count: $0.value) }
            .sorted { lhs, rhs in
                if lhs.count != rhs.count { return lhs.count > rhs.count }
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
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
