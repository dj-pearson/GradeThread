import Foundation

/// Pure helpers used by `InventoryListView` to bridge SwiftData @Query
/// results to the user-visible list. Kept separate so the predicate
/// semantics (which fields a search query hits, which statuses belong
/// to which stage) can be unit-tested without any SwiftUI plumbing.
public enum InventoryFilter {

    /// Applies stage + (optional) graded-only + search + sort in that order.
    /// The pipeline order matters: stage filtering is the cheapest cut,
    /// graded-only narrows further, search is substring-based on a small set
    /// of fields, sort is the final pass.
    static func apply(
        _ items: [LocalInventoryItem],
        stage: InventoryStage,
        search: String,
        sort: SortOption,
        gradedOnly: Bool = false
    ) -> [LocalInventoryItem] {
        var staged = items.filter { stage.matchingStatuses.contains($0.status) }
        if gradedOnly {
            staged = staged.filter { $0.gradeValue != nil }
        }
        let searched = filter(staged, search: search)
        return searched.sorted(by: sort.isOrdered)
    }

    /// Full pipeline with the advanced ``InventoryFilterCriteria`` facets
    /// layered in after the stage cut and before search + sort. Order:
    /// stage (cheapest) → facets → search → sort. The legacy `gradedOnly`
    /// overload above is kept for the existing call sites/tests; new code
    /// should fold `gradedOnly` into the criteria instead.
    static func apply(
        _ items: [LocalInventoryItem],
        stage: InventoryStage,
        search: String,
        sort: SortOption,
        criteria: InventoryFilterCriteria,
        now: Date = .now
    ) -> [LocalInventoryItem] {
        let staged = items.filter { stage.matchingStatuses.contains($0.status) }
        let faceted = staged.filter { matches($0, criteria, now: now) }
        let searched = filter(faceted, search: search)
        return searched.sorted(by: sort.isOrdered)
    }

    /// Effective price used by both the price-band facet and the price
    /// facets bounds: most-specific known price wins (listed → target →
    /// acquired), matching the row's price-display fallback.
    static func effectivePrice(_ item: LocalInventoryItem) -> Double? {
        item.listingPrice ?? item.targetPrice ?? item.acquiredPrice
    }

    /// True when an item satisfies every active facet in `criteria`. An
    /// empty criteria matches everything. Multi-select facets are OR within
    /// a facet (any selected brand) and AND across facets (brand AND size).
    static func matches(
        _ item: LocalInventoryItem,
        _ criteria: InventoryFilterCriteria,
        now: Date = .now
    ) -> Bool {
        if !criteria.brands.isEmpty {
            guard let b = item.brand?.facetTrimmed, criteria.brands.contains(b) else { return false }
        }
        if !criteria.sizes.isEmpty {
            guard let s = item.size?.facetTrimmed, criteria.sizes.contains(s) else { return false }
        }
        if !criteria.colors.isEmpty {
            guard let c = item.color?.facetTrimmed, criteria.colors.contains(c) else { return false }
        }

        if criteria.gradedOnly || criteria.minGrade != nil {
            guard let grade = item.gradeValue else { return false }
            if let floor = criteria.minGrade, grade < floor { return false }
        }

        if criteria.minPrice != nil || criteria.maxPrice != nil {
            guard let price = effectivePrice(item) else { return false }
            if let lo = criteria.minPrice, price < lo { return false }
            if let hi = criteria.maxPrice, price > hi { return false }
        }

        switch criteria.photoState {
        case .any:          break
        case .withPhoto:    if item.primaryPhotoURL?.facetTrimmed == nil { return false }
        case .missingPhoto: if item.primaryPhotoURL?.facetTrimmed != nil { return false }
        }

        if let days = criteria.dateAdded.days {
            let cutoff = now.addingTimeInterval(-Double(days) * 86_400)
            if item.createdAt < cutoff { return false }
        }

        return true
    }

    /// Substring match against title / brand / style / SKU / container —
    /// matches the web's `InventoryFilter.matchesText` field set.
    static func filter(_ items: [LocalInventoryItem], search: String) -> [LocalInventoryItem] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return items }
        return items.filter { matches(item: $0, needle: needle) }
    }

    private static func matches(item: LocalInventoryItem, needle: String) -> Bool {
        if contains(item.title, needle) { return true }
        if contains(item.brand, needle) { return true }
        // Style + container aren't on LocalInventoryItem yet (they live in
        // items_full on the web). When the sync engine starts pulling
        // them we'll add the comparisons here without breaking the API.
        if contains(item.sku, needle) { return true }
        return false
    }

    private static func contains(_ haystack: String?, _ needle: String) -> Bool {
        guard let haystack else { return false }
        return haystack.lowercased().contains(needle)
    }
}
