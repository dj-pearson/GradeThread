package com.gradethread.app.marketplaces.pricing

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1355: data for the bulk price editor.
 *
 * Listings are read straight from Postgres rather than the Room mirror, for one
 * reason: the editor needs `listing_title`, which the local cache doesn't
 * carry. Reads go through the anon client, so RLS scopes them to the owner.
 * The push goes through the edge, which owns the eBay call.
 */
@Singleton
class BulkPricingService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
    private val client: SupabaseClient,
) {

    @Serializable
    private data class BulkRequest(val updates: List<BulkPriceUpdate>)

    companion object {
        const val BULK_PATH = "/api/flipdesk/ebay/listings/bulk-price-quantity"
        private const val TABLE = "listings"
        private const val PAGE = 500
    }

    /**
     * Active eBay listings that can actually be repriced.
     *
     * Filtered to rows with an offer id: the bulk endpoint addresses eBay's
     * Inventory API, which only knows about offers GradeThread published. An
     * imported listing has no offer, so including it would put rows in the
     * editor that always fail. Done client-side to avoid the not-null filter
     * quirk on the hosted PostgREST.
     */
    suspend fun listings(): List<BulkListing> =
        client.from(TABLE).select(
            Columns.raw("id, listing_title, listing_price, quantity, platform_offer_id"),
        ) {
            filter {
                eq("platform", "ebay")
                eq("listing_status", "active")
            }
            order("listed_at", Order.DESCENDING)
            limit(PAGE.toLong())
        }.decodeList<BulkListingRow>()
            .filter { !it.platformOfferId.isNullOrBlank() }
            .map {
                BulkListing(
                    id = it.id,
                    title = it.listingTitle?.takeIf { t -> t.isNotBlank() } ?: "Untitled listing",
                    price = it.listingPrice,
                    quantity = it.quantity,
                )
            }

    /** Push the updates. The server reports per-listing, never all-or-nothing. */
    suspend fun apply(updates: List<BulkPriceUpdate>): BulkPriceResponse =
        edge.json.decodeFromString(
            BulkPriceResponse.serializer(),
            edge.postRaw(
                BULK_PATH,
                edge.json.encodeToString(BulkRequest.serializer(), BulkRequest(updates)),
            ),
        )

    fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Couldn't push those prices to eBay."
}
