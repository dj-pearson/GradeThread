package com.gradethread.app.inventory

import com.gradethread.app.sync.db.InventoryItemEntity

/** Photo-presence facet. */
enum class PhotoState { ANY, WITH_PHOTO, MISSING_PHOTO }

/** Relative date-added band. */
enum class DateAddedBand(val days: Int?) {
    ANY(null),
    LAST_7(7),
    LAST_30(30),
    LAST_90(90),
}

/**
 * US-1342: the committed filter state.
 *
 * Multi-select facets are OR WITHIN a facet (any selected brand) and AND
 * ACROSS facets (brand AND size).
 */
data class InventoryFilterCriteria(
    val brands: Set<String> = emptySet(),
    val sizes: Set<String> = emptySet(),
    val colors: Set<String> = emptySet(),
    val locationBins: Set<String> = emptySet(),
    val sources: Set<String> = emptySet(),
    val categories: Set<String> = emptySet(),
    /**
     * US-3124: WHO bought the item, selected by name. [sources] is WHERE it
     * came from and holds ids — two different questions, two different columns.
     */
    val sourcers: Set<String> = emptySet(),
    val gradedOnly: Boolean = false,
    val minGrade: Double? = null,
    val minPrice: Double? = null,
    val maxPrice: Double? = null,
    val photoState: PhotoState = PhotoState.ANY,
    val dateAdded: DateAddedBand = DateAddedBand.ANY,
) {
    /**
     * The toolbar badge counts ACTIVE FACETS, not selections — three brands
     * is 1, not 3, because it's one thing the seller has to undo.
     */
    val activeCount: Int
        get() = listOf(
            brands.isNotEmpty(),
            sizes.isNotEmpty(),
            colors.isNotEmpty(),
            locationBins.isNotEmpty(),
            sources.isNotEmpty(),
            categories.isNotEmpty(),
            sourcers.isNotEmpty(),
            gradedOnly || minGrade != null,
            minPrice != null || maxPrice != null,
            photoState != PhotoState.ANY,
            dateAdded != DateAddedBand.ANY,
        ).count { it }

    val isEmpty: Boolean get() = activeCount == 0
}

/**
 * US-1342: the derivation pipeline (iOS `InventoryFilter`).
 *
 * Order is fixed and load-bearing: **stage → facets → search → sort**. The
 * server-search union is applied INSIDE the search step, so a server hit can
 * bypass the local text match but can never resurrect an item that stage or
 * facets already excluded.
 */
object InventoryFilter {

    /** The 14 fields the local search covers. */
    fun searchableText(item: InventoryItemEntity): String = listOfNotNull(
        item.title, item.brand, item.sku, item.size, item.color, item.material,
        item.itemCategory, item.style, item.garmentType, item.garmentCategory,
        item.conditionNotes, item.locationBin, item.container, item.sourcedBy,
    ).joinToString(" ").lowercase()

    /** Lowercase, split on anything non-alphanumeric, drop empties. */
    fun searchTokens(search: String): List<String> =
        search.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }

    /** Most-specific price wins. */
    fun effectivePrice(item: InventoryItemEntity): Double? = item.listingPrice ?: item.targetPrice ?: item.acquiredPrice

    /**
     * @param photoItemIds ids known to have photo ROWS. US-994: the
     * denormalized cover URL lags the real photo set, so presence is decided
     * by rows, never by `primaryPhotoUrl`.
     */
    fun matches(
        item: InventoryItemEntity,
        criteria: InventoryFilterCriteria,
        photoItemIds: Set<String>?,
        nowMillis: Long,
    ): Boolean {
        if (criteria.brands.isNotEmpty() && item.brand?.trim() !in criteria.brands) return false
        if (criteria.sizes.isNotEmpty() && item.size?.trim() !in criteria.sizes) return false
        if (criteria.colors.isNotEmpty() && item.color?.trim() !in criteria.colors) return false
        if (criteria.locationBins.isNotEmpty() &&
            item.locationBin?.trim() !in criteria.locationBins
        ) {
            return false
        }
        if (criteria.sources.isNotEmpty() && item.sourceId?.trim() !in criteria.sources) return false
        // An item with nobody recorded matches no selection, the same way an
        // unbranded item matches no brand.
        if (criteria.sourcers.isNotEmpty() && item.sourcedBy?.trim() !in criteria.sourcers) {
            return false
        }
        if (criteria.categories.isNotEmpty() &&
            item.itemCategory?.trim() !in criteria.categories
        ) {
            return false
        }

        if (criteria.gradedOnly || criteria.minGrade != null) {
            val grade = item.gradeValue ?: return false
            criteria.minGrade?.let { if (grade < it) return false }
        }

        if (criteria.minPrice != null || criteria.maxPrice != null) {
            val price = effectivePrice(item)
            if (price != null) {
                criteria.minPrice?.let { if (price < it) return false }
                criteria.maxPrice?.let { if (price > it) return false }
            } else if (criteria.minPrice != null) {
                // US-1247, asymmetric on purpose: a ceiling-only band KEEPS
                // unpriced items (they might be cheap), but any floor drops
                // them (an unpriced item can't be shown to clear a minimum).
                return false
            }
        }

        if (criteria.photoState != PhotoState.ANY) {
            val hasPhotos = photoItemIds?.contains(item.id) ?: false
            if (criteria.photoState == PhotoState.WITH_PHOTO && !hasPhotos) return false
            if (criteria.photoState == PhotoState.MISSING_PHOTO && hasPhotos) return false
        }

        criteria.dateAdded.days?.let { days ->
            if (item.createdAt < nowMillis - days * 86_400_000L) return false
        }

        return true
    }

    /**
     * @param serverSearchIds ids the server FTS matched, or null when the
     * server search didn't run (query too short, offline, or it failed).
     */
    fun apply(
        items: List<InventoryItemEntity>,
        stage: InventoryStage,
        query: String,
        sort: SortOption,
        criteria: InventoryFilterCriteria,
        photoItemIds: Set<String>? = null,
        serverSearchIds: Set<String>? = null,
        nowMillis: Long = System.currentTimeMillis(),
    ): List<InventoryItemEntity> {
        val tokens = searchTokens(query)
        return items
            .asSequence()
            .filter { stage.matches(it.status) }
            .filter { matches(it, criteria, photoItemIds, nowMillis) }
            .filter { item ->
                if (tokens.isEmpty()) return@filter true
                // Server hit short-circuits the local token match — but only
                // after stage and facets have already had their say.
                if (serverSearchIds?.contains(item.id) == true) return@filter true
                val hay = searchableText(item)
                // Substring, not token equality: "nik" finds Nike.
                tokens.all { hay.contains(it) }
            }
            .sortedWith(sort.comparator())
            .toList()
    }
}
