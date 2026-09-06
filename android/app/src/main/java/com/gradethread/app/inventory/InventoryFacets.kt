package com.gradethread.app.inventory

import com.gradethread.app.sync.db.InventoryItemEntity

/** One selectable facet value and how many items carry it. */
data class FacetValue(val value: String, val label: String, val count: Int)

data class InventoryFacets(
    val brands: List<FacetValue> = emptyList(),
    val sizes: List<FacetValue> = emptyList(),
    val colors: List<FacetValue> = emptyList(),
    val locationBins: List<FacetValue> = emptyList(),
    val sources: List<FacetValue> = emptyList(),
    val categories: List<FacetValue> = emptyList(),
    /**
     * US-3124: WHO bought the item (`inventory_items.sourced_by`). Keyed AND
     * labelled by the name, unlike [sources], which keys on an id — the column
     * stores the name itself on every platform.
     */
    val sourcers: List<FacetValue> = emptyList(),
    val priceRange: ClosedFloatingPointRange<Double>? = null,
)

/**
 * US-1342: derives the selectable facet values from the current item set
 * (iOS `InventoryFacets`).
 */
object InventoryFacetsBuilder {

    /**
     * Alpha sizes sort in wearing order, not alphabetically — an S/M/L list
     * ordered "L, M, S" is unusable.
     */
    private val sizeRank: Map<String, Int> = mapOf(
        "xxs" to 0, "xs" to 1, "s" to 2, "small" to 2, "m" to 3, "medium" to 3,
        "l" to 4, "large" to 4, "xl" to 5, "xxl" to 6, "2xl" to 6,
        "xxxl" to 7, "3xl" to 7,
    )

    /** Anything unrecognized sorts after the known alpha sizes. */
    const val UNRANKED_SIZE = 100

    fun sizeRankOf(size: String): Int = sizeRank[size.trim().lowercase()] ?: UNRANKED_SIZE

    fun derive(items: List<InventoryItemEntity>, sourceNames: Map<String, String> = emptyMap()): InventoryFacets {
        fun counts(selector: (InventoryItemEntity) -> String?): Map<String, Int> {
            val out = mutableMapOf<String, Int>()
            for (item in items) {
                // Blank and whitespace-only values are dropped — an empty
                // chip is unselectable noise.
                val value = selector(item)?.trim()?.takeIf { it.isNotEmpty() } ?: continue
                out[value] = (out[value] ?: 0) + 1
            }
            return out
        }

        /** Count descending, then label case-insensitive ascending. */
        fun ranked(counts: Map<String, Int>, label: (String) -> String = { it }): List<FacetValue> =
            counts.map { (value, count) -> FacetValue(value, label(value), count) }
                .sortedWith(
                    compareByDescending<FacetValue> { it.count }
                        .thenBy(String.CASE_INSENSITIVE_ORDER) { it.label },
                )

        val prices = items.mapNotNull { InventoryFilter.effectivePrice(it) }
        val priceRange = if (prices.isEmpty()) {
            null
        } else {
            val lo = prices.min()
            val hi = prices.max()
            // A degenerate range breaks a slider, so widen it by 1.
            if (lo < hi) lo..hi else lo..(lo + 1)
        }

        return InventoryFacets(
            brands = ranked(counts { it.brand }),
            sizes = counts { it.size }
                .map { (value, count) -> FacetValue(value, value, count) }
                .sortedWith(
                    compareBy<FacetValue> { sizeRankOf(it.value) }
                        .thenComparator { a, b -> SortOption.naturalCompare(a.value, b.value) },
                ),
            colors = ranked(counts { it.color }),
            locationBins = ranked(counts { it.locationBin }),
            // Keyed by source id, labelled by name — a rename must change the
            // label without changing the selection.
            sources = ranked(counts { it.sourceId }) { id -> sourceNames[id] ?: id },
            categories = ranked(counts { it.itemCategory }),
            sourcers = ranked(counts { it.sourcedBy }),
            priceRange = priceRange,
        )
    }
}
