import Foundation

/// US-1017: main-thread memoization for the inventory screen's three expensive
/// derived collections — the filtered+sorted list, the per-stage counts, and
/// the filter-sheet facet index.
///
/// SwiftUI re-evaluates a view's `body` on *every* `@State` change, including
/// ones that have nothing to do with filtering (presenting the sync sheet,
/// toggling select mode, a transient refresh banner). Any computed property
/// read during that pass is recomputed from scratch. On a large catalog the
/// full `InventoryFilter.apply` (O(n) match + O(n log n) sort), the per-stage
/// count pass (O(n · stages)), and `InventoryFacets.derive` (O(n) + several
/// sorts) are all wasted work when their inputs haven't changed.
///
/// This cache stores the last result of each derivation keyed on a cheap
/// integer signature of its inputs; a getter recomputes only when that
/// signature changes. It is held in `@State` as a reference type so the cache
/// survives the value-type view being re-created across renders, and — because
/// it is a plain `final class`, NOT `@Observable`/`ObservableObject` — mutating
/// the cache during `body` does not itself invalidate the view (no render
/// loop).
///
/// The `*PassCount` properties are instrumentation: tests assert a derivation
/// runs at most once for a stable key (and once more per genuine input change),
/// which is exactly the "doesn't recompute on unrelated re-renders" contract.
final class InventoryDerivation {

    // MARK: - Memo slots

    private var filteredKey: Int?
    private var filteredValue: [LocalInventoryItem] = []

    private var stageCountsKey: Int?
    private var stageCountsValue: [InventoryStage: Int] = [:]

    private var facetsKey: Int?
    private var facetsValue: InventoryFacets = .empty

    // US-1520: item ids with at least one cached photo, for the photo facet.
    private var photoItemIdsKey: Int?
    private var photoItemIdsValue: Set<String> = []

    // MARK: - Instrumentation (for tests)

    /// Number of times the full filter+sort pass actually executed.
    private(set) var filterPassCount = 0
    /// Number of times the per-stage count pass actually executed.
    private(set) var stageCountsPassCount = 0
    /// Number of times the facet derive actually executed.
    private(set) var facetsPassCount = 0

    // MARK: - Memoized getters

    /// Returns the cached filtered list, recomputing via `compute` only when
    /// `key` differs from the last call.
    func filteredItems(key: Int, _ compute: () -> [LocalInventoryItem]) -> [LocalInventoryItem] {
        if filteredKey != key {
            filteredKey = key
            filteredValue = compute()
            filterPassCount += 1
        }
        return filteredValue
    }

    /// Returns the cached per-stage counts, recomputing only on `key` change.
    func stageCounts(key: Int, _ compute: () -> [InventoryStage: Int]) -> [InventoryStage: Int] {
        if stageCountsKey != key {
            stageCountsKey = key
            stageCountsValue = compute()
            stageCountsPassCount += 1
        }
        return stageCountsValue
    }

    /// Returns the cached facet index, recomputing only on `key` change. The
    /// key folds in the item signature *and* the source-name map, so renaming a
    /// source (which changes only labels) still refreshes the facet.
    func facets(key: Int, _ compute: () -> InventoryFacets) -> InventoryFacets {
        if facetsKey != key {
            facetsKey = key
            facetsValue = compute()
            facetsPassCount += 1
        }
        return facetsValue
    }

    /// US-1520: cached photo-bearing item id set (one `LocalItemPhoto` id pass),
    /// recomputing only on `key` change. Feeds the photo facet so
    /// ``InventoryFilter/matches`` never faults each item's lazy `photos`
    /// relationship. Same staleness contract as the filter memo: the items
    /// signature gates it, and a photo change reaches the list via the same
    /// signals that already refresh the filtered list.
    func photoItemIds(key: Int, _ compute: () -> Set<String>) -> Set<String> {
        if photoItemIdsKey != key {
            photoItemIdsKey = key
            photoItemIdsValue = compute()
        }
        return photoItemIdsValue
    }

    // MARK: - Cache keys (pure, shared with the view + unit-testable)

    /// Cheap content signature of an item snapshot — `count` folded with each
    /// row's `id` + `updatedAt`. Two snapshots with identical (id, updatedAt)
    /// pairs hash equal, so an unrelated `body` re-render (same cache) reuses the
    /// memo; any edit bumps `updatedAt` and invalidates it. O(n) but far cheaper
    /// than the passes it gates. The per-process `Hasher` seed is stable within a
    /// run, so signatures are only ever compared against others built in the
    /// same process.
    static func itemsSignature(_ items: [LocalInventoryItem]) -> Int {
        var hasher = Hasher()
        hasher.combine(items.count)
        for item in items {
            hasher.combine(item.id)
            hasher.combine(item.updatedAt)
        }
        return hasher.finalize()
    }

    /// Key for the filtered+sorted list. Folds in exactly the inputs
    /// ``InventoryFilter/apply(_:stage:search:sort:criteria:now:soldDates:serverSearchIds:)``
    /// reads — nothing else — so an unrelated `@State` change leaves it
    /// unchanged and the memo holds.
    static func filterKey(
        itemsSignature: Int,
        stage: InventoryStage,
        query: String,
        sort: SortOption,
        criteria: InventoryFilterCriteria,
        soldDates: [String: Date],
        serverSearchIds: Set<String>?,
        unlistedFilter: InventoryStage.UnlistedFilter = .all
    ) -> Int {
        var hasher = Hasher()
        hasher.combine(itemsSignature)
        hasher.combine(stage)
        hasher.combine(query)
        hasher.combine(sort)
        hasher.combine(criteria)
        hasher.combine(soldDates)
        hasher.combine(serverSearchIds)
        hasher.combine(unlistedFilter)
        return hasher.finalize()
    }

    /// Key for the facet index — the item signature plus the source-name map (a
    /// source rename changes labels only, but must still refresh the facet).
    static func facetsKey(itemsSignature: Int, sourceNames: [String: String]) -> Int {
        var hasher = Hasher()
        hasher.combine(itemsSignature)
        hasher.combine(sourceNames)
        return hasher.finalize()
    }
}
