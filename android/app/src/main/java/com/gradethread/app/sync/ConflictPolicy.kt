package com.gradethread.app.sync

/**
 * US-1318: field-level merge rules between a locally-cached row and a
 * freshly-pulled server row (iOS ConflictPolicy — the same policy the web app
 * and edge use for FlipDesk ↔ eBay ↔ Sheets reconciliation, US-148/1086;
 * vault/20-domain/sync-source-of-truth.md is the cross-platform contract).
 *
 * Four strategies:
 *  - SERVER-OWNED — marketplace/pipeline-authored fields (listing_price,
 *    listing_status, sale money, payout refs, grade_value): server always
 *    wins; a client edit makes no sense.
 *  - USER-OWNED-IF-DIRTY — user-authored fields (title, brand,
 *    condition_notes, target_price, measurements): local wins while
 *    `hasLocalChanges` marks the row dirty (the ONLY editedness truth);
 *    server wins when clean.
 *  - NEWEST-WINS — neutral fields, by row updated_at.
 *  - EBAY-ORIGIN-AWARE — eBay-owned editable listing fields: for an
 *    ebay-originated listing the SERVER always wins (eBay is the source of
 *    truth); gradethread-originated (or unknown) falls back to
 *    user-owned-if-dirty.
 */
object ConflictPolicy {

    /** Marketplace-authored: server always wins. */
    fun <T> resolveServerOwned(@Suppress("UNUSED_PARAMETER") local: T, server: T): T = server

    /** User-authored: local wins while dirty; server when clean. */
    fun <T> resolveUserOwned(local: T, server: T, hasLocalChanges: Boolean): T =
        if (hasLocalChanges) local else server

    /** Neutral: newest row wins (server on ties — it already round-tripped). */
    fun <T> resolveByTimestamp(
        local: T,
        server: T,
        localUpdatedAtMs: Long,
        serverUpdatedAtMs: Long,
    ): T = if (serverUpdatedAtMs >= localUpdatedAtMs) server else local

    /** Listing provenance (US-1086; vault/20-domain/sync-source-of-truth.md). */
    enum class ListingOrigin(val wire: String) {
        GRADETHREAD("gradethread"),
        EBAY("ebay"),
        ;

        companion object {
            fun fromWire(value: String?): ListingOrigin? =
                entries.firstOrNull { it.wire == value }
        }
    }

    /**
     * eBay-owned editable listing fields (title/price/condition/quantity/
     * description/policies): ebay-originated → server always; otherwise the
     * user-owned rule.
     */
    fun <T> resolveEbayOwnedListingField(
        local: T,
        server: T,
        hasLocalChanges: Boolean,
        listingOrigin: String?,
    ): T {
        if (ListingOrigin.fromWire(listingOrigin) == ListingOrigin.EBAY) return server
        return resolveUserOwned(local, server, hasLocalChanges)
    }

    // ── US-1244: market-price selection ──────────────────────────────────────

    /** Listing statuses that represent a currently-live listing. */
    val liveListingStatuses: Set<String> = setOf("active", "relisted")

    data class ListingPriceRow(
        val itemId: String,
        val price: Double,
        val atMs: Long,
        val isLive: Boolean,
    )

    /**
     * Choose each item's market price from its LIVE listing when one exists —
     * a live listing beats a non-live one REGARDLESS of timestamp; within the
     * same liveness class the newer listed_at/created_at wins (US-1244).
     */
    fun selectListingPrices(rows: List<ListingPriceRow>): Map<String, Double> {
        val prices = mutableMapOf<String, Double>()
        val at = mutableMapOf<String, Long>()
        val live = mutableMapOf<String, Boolean>()
        for (row in rows) {
            val prevAt = at[row.itemId]
            if (prevAt != null) {
                val prevLive = live[row.itemId] ?: false
                if (prevLive && !row.isLive) continue // live beats non-live
                if (prevLive == row.isLive && prevAt >= row.atMs) continue // same class → newer
            }
            at[row.itemId] = row.atMs
            prices[row.itemId] = row.price
            live[row.itemId] = row.isLive
        }
        return prices
    }
}
