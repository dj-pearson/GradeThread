package com.gradethread.app.inventory

import com.gradethread.app.sync.db.InventoryItemEntity

/**
 * US-1342: a keyed memo over the derivation pipeline (iOS
 * `InventoryDerivation`).
 *
 * The point is that the inventory screen has ~20 pieces of unrelated UI state
 * — a filter sheet opening, select mode toggling, a refresh banner — and each
 * of them recomposes the screen. Without this cache every one of those would
 * re-run a full O(n log n) filter + sort over the whole inventory.
 *
 * Each slot's key is built from EXACTLY the inputs its computation reads and
 * nothing else, so unrelated state cannot invalidate it. Hold one instance
 * per screen (`remember`), not per composition.
 *
 * Not thread-safe: it is read during composition on the main thread.
 */
class InventoryDerivation {

    private var filteredKey: Int? = null
    private var filteredValue: List<InventoryItemEntity> = emptyList()

    private var stageCountsKey: Int? = null
    private var stageCountsValue: Map<InventoryStage, Int> = emptyMap()

    private var facetsKey: Int? = null
    private var facetsValue: InventoryFacets = InventoryFacets()

    /**
     * Pass counters exist so tests can assert the memo contract directly —
     * "the value was right" is not the same claim as "it didn't recompute".
     */
    var filterPassCount: Int = 0
        private set
    var stageCountsPassCount: Int = 0
        private set
    var facetsPassCount: Int = 0
        private set

    // Every parameter is an input `apply` reads; the count is the filter's arity.
    @Suppress("LongParameterList")
    fun filtered(
        items: List<InventoryItemEntity>,
        stage: InventoryStage,
        query: String,
        sort: SortOption,
        criteria: InventoryFilterCriteria,
        photoItemIds: Set<String>? = null,
        serverSearchIds: Set<String>? = null,
        nowMillis: Long = System.currentTimeMillis(),
        unlistedFilter: UnlistedFilter = UnlistedFilter.ALL,
    ): List<InventoryItemEntity> {
        val key = filterKey(
            itemsSignature(items),
            stage,
            query,
            sort,
            criteria,
            photoItemIds,
            serverSearchIds,
            unlistedFilter,
        )
        if (key != filteredKey) {
            filteredKey = key
            filterPassCount++
            filteredValue = InventoryFilter.apply(
                items = items,
                stage = stage,
                query = query,
                sort = sort,
                criteria = criteria,
                photoItemIds = photoItemIds,
                serverSearchIds = serverSearchIds,
                nowMillis = nowMillis,
                unlistedFilter = unlistedFilter,
            )
        }
        return filteredValue
    }

    /** Counts every user-facing stage in one pass; ALL counts everything. */
    fun stageCounts(items: List<InventoryItemEntity>): Map<InventoryStage, Int> {
        val key = itemsSignature(items)
        if (key != stageCountsKey) {
            stageCountsKey = key
            stageCountsPassCount++
            val counts = mutableMapOf<InventoryStage, Int>()
            for (stage in InventoryStage.userFacing) counts[stage] = 0
            for (item in items) {
                for (stage in InventoryStage.userFacing) {
                    if (stage.matches(item.status)) counts[stage] = (counts[stage] ?: 0) + 1
                }
            }
            stageCountsValue = counts
        }
        return stageCountsValue
    }

    fun facets(items: List<InventoryItemEntity>, sourceNames: Map<String, String> = emptyMap()): InventoryFacets {
        // sourceNames is in the key because a source RENAME changes labels
        // without changing any item, and the facet list must still refresh.
        val key = 31 * itemsSignature(items) + sourceNames.hashCode()
        if (key != facetsKey) {
            facetsKey = key
            facetsPassCount++
            facetsValue = InventoryFacetsBuilder.derive(items, sourceNames)
        }
        return facetsValue
    }

    companion object {
        /**
         * Folds count + each row's id and updatedAt, so an EDIT invalidates
         * (updatedAt moves) but a re-render with the same rows does not.
         *
         * Never persist this — it is only ever compared against another
         * signature computed in the same process.
         */
        fun itemsSignature(items: List<InventoryItemEntity>): Int {
            var hash = items.size
            for (item in items) {
                hash = 31 * hash + item.id.hashCode()
                hash = 31 * hash + item.updatedAt.hashCode()
            }
            return hash
        }

        /** Exactly the eight inputs `apply` reads — nothing else. */
        @Suppress("LongParameterList")
        fun filterKey(
            itemsSignature: Int,
            stage: InventoryStage,
            query: String,
            sort: SortOption,
            criteria: InventoryFilterCriteria,
            photoItemIds: Set<String>?,
            serverSearchIds: Set<String>?,
            unlistedFilter: UnlistedFilter = UnlistedFilter.ALL,
        ): Int {
            var hash = itemsSignature
            hash = 31 * hash + stage.hashCode()
            hash = 31 * hash + query.hashCode()
            hash = 31 * hash + sort.hashCode()
            hash = 31 * hash + criteria.hashCode()
            hash = 31 * hash + (photoItemIds?.hashCode() ?: 0)
            hash = 31 * hash + (serverSearchIds?.hashCode() ?: 0)
            hash = 31 * hash + unlistedFilter.hashCode()
            return hash
        }
    }
}
