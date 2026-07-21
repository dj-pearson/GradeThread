package com.gradethread.app.inventory

import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.ListingEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.sync.db.SourceEntity

/**
 * US-1349: matching one query across the four local tables.
 *
 * Pure, and computed ONCE per debounced query. iOS learned this the expensive
 * way (US-1517): each section's matches were a computed property re-evaluated
 * at least twice per render, rebuilding the item index inside a filter closure
 * every time — which is exactly the shape that makes a search box stutter on a
 * large inventory.
 */
object GlobalSearch {

    /** Per-section cap. Twenty is what fits before a seller re-types anyway. */
    const val SECTION_LIMIT = 20

    /** Below this a query matches most of the inventory and helps nobody. */
    const val MIN_QUERY_LENGTH = 2

    data class ListingHit(val listing: ListingEntity, val item: InventoryItemEntity)
    data class SaleHit(val sale: SaleEntity, val item: InventoryItemEntity)

    data class Results(
        val items: List<InventoryItemEntity> = emptyList(),
        val listings: List<ListingHit> = emptyList(),
        val sales: List<SaleHit> = emptyList(),
        val sources: List<SourceEntity> = emptyList(),
    ) {
        val isEmpty: Boolean
            get() = items.isEmpty() && listings.isEmpty() && sales.isEmpty() && sources.isEmpty()

        val total: Int get() = items.size + listings.size + sales.size + sources.size
    }

    /**
     * Compute the whole result set.
     *
     * @param serverItemIds ids the server's full-text search matched, or null
     *   when it didn't run. Null means "no server opinion", NOT "no matches" —
     *   conflating them would let a failed RPC empty a search that local
     *   matching had already answered.
     */
    fun compute(
        query: String,
        items: List<InventoryItemEntity>,
        listings: List<ListingEntity>,
        sales: List<SaleEntity>,
        sources: List<SourceEntity>,
        serverItemIds: Set<String>? = null,
    ): Results {
        val needle = query.trim().lowercase()
        if (needle.length < MIN_QUERY_LENGTH) return Results()

        // Built once, not inside each filter — the US-1517 lesson.
        val itemsById = items.associateBy { it.id }

        fun matches(vararg haystacks: String?): Boolean =
            haystacks.any { it?.lowercase()?.contains(needle) == true }

        val matchedItems = items.filter { item ->
            // The server hit is ADDITIVE: it can only widen the local result,
            // never narrow it.
            item.id in (serverItemIds ?: emptySet()) ||
                matches(item.title, item.brand, item.sku, item.size, item.color, item.material)
        }.take(SECTION_LIMIT)

        // Listings and sales only appear when their parent item is CACHED
        // (US-1187). A hit whose item hasn't synced would render a row with no
        // title and no working tap target — worse than not showing it.
        val matchedListings = listings.mapNotNull { listing ->
            val item = itemsById[listing.inventoryItemId] ?: return@mapNotNull null
            if (matches(listing.platform, listing.listingStatus, item.title)) {
                ListingHit(listing, item)
            } else {
                null
            }
        }.take(SECTION_LIMIT)

        val matchedSales = sales.mapNotNull { sale ->
            val item = itemsById[sale.inventoryItemId] ?: return@mapNotNull null
            if (matches(sale.buyerUsername, item.title)) SaleHit(sale, item) else null
        }.take(SECTION_LIMIT)

        val matchedSources = sources.filter { source ->
            matches(source.name, source.notes, source.sourceType)
        }.take(SECTION_LIMIT)

        return Results(matchedItems, matchedListings, matchedSales, matchedSources)
    }

    /**
     * Where a result opens.
     *
     * Everything routes through the ITEM, including listing and sale hits: an
     * item is the only surface that exists for all four, and a seller who
     * searched a buyer's username wants the garment they bought, not a row in
     * a ledger they can't act on.
     */
    fun routeFor(kind: Kind, itemId: String): String = when (kind) {
        Kind.ITEM, Kind.LISTING, Kind.SALE -> "item/$itemId"
        // A source has no detail screen yet; the inventory list filtered by it
        // is the closest honest destination.
        Kind.SOURCE -> "inventory"
    }

    enum class Kind { ITEM, LISTING, SALE, SOURCE }
}
