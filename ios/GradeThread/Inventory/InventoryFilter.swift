import Foundation

/// Pure helpers used by `InventoryListView` to bridge SwiftData @Query
/// results to the user-visible list. Kept separate so the predicate
/// semantics (which fields a search query hits, which statuses belong
/// to which stage) can be unit-tested without any SwiftUI plumbing.
public enum InventoryFilter {

    /// Applies stage + search + sort in that order. The pipeline order
    /// matters: stage filtering is the cheapest cut, search is
    /// substring-based on a small set of fields, sort is the final pass.
    static func apply(
        _ items: [LocalInventoryItem],
        stage: InventoryStage,
        search: String,
        sort: SortOption
    ) -> [LocalInventoryItem] {
        let staged = items.filter { stage.matchingStatuses.contains($0.status) }
        let searched = filter(staged, search: search)
        return searched.sorted(by: sort.isOrdered)
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
