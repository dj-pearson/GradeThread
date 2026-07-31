package com.gradethread.app.marketplaces.promotions

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1357: per-listing promotions (ad rate) and markdown sales.
 *
 * Both live under the listing, and both are server-mediated — the edge owns the
 * eBay Marketing calls and the promotion id it has to remember to end a sale.
 */
@Singleton
class PromotionService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        fun promotionPath(listingId: String) = "/api/flipdesk/ebay/listings/$listingId/promotion"
        fun salePath(listingId: String) = "/api/flipdesk/ebay/listings/$listingId/sale"
    }

    suspend fun state(listingId: String): PromotionState =
        edge.json.decodeFromString(
            PromotionState.serializer(),
            edge.getRaw(promotionPath(listingId)),
        )

    /** Start or update the ad rate. Returns the rate eBay actually applied. */
    suspend fun promote(listingId: String, ratePct: Double): Double? {
        val raw = edge.postRaw(
            promotionPath(listingId),
            edge.json.encodeToString(
                PromotionSetRequest.serializer(),
                PromotionSetRequest(Promotions.clampAdRate(ratePct)),
            ),
        )
        return edge.json.decodeFromString(PromotionSetResponse.serializer(), raw).ratePct
    }

    /** Stop promoting. The listing stays live; only the ad ends. */
    suspend fun stopPromoting(listingId: String) {
        edge.deleteRaw(promotionPath(listingId))
    }

    /**
     * Start a markdown sale. [endDate] is optional — without one the sale runs
     * until it is ended.
     */
    suspend fun startSale(listingId: String, percentOff: Double, endDate: String? = null) {
        edge.postRaw(
            salePath(listingId),
            edge.json.encodeToString(
                SaleRequest.serializer(),
                SaleRequest(Promotions.clampMarkdown(percentOff), endDate),
            ),
        )
    }

    /** End the sale and restore the original price — the markdown is an overlay. */
    suspend fun endSale(listingId: String) {
        edge.deleteRaw(salePath(listingId))
    }

    fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "eBay wouldn't take that change."
}
