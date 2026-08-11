package com.gradethread.app.marketplaces.publish

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1352: the two publish endpoints behind one typed surface (iOS
 * `EbayPublishService`).
 *
 * Each call returns a [PublishOutcome] instead of throwing, so the caller
 * switches over the cases: the 422 "blockers" branch and the 402 plan wall are
 * both things the seller must ACT on, and a raw HTTP error collapses them into
 * the same dead end.
 */
@Singleton
class EbayPublishService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    @Serializable
    private data class ValidateRequest(
        @SerialName("inventory_item_id") val inventoryItemId: String,
    )

    @Serializable
    private data class PriceRequest(val price: Double)

    @Serializable
    private data class ReviseRequest(
        val title: String? = null,
        val description: String? = null,
        @SerialName("listing_price") val listingPrice: Double? = null,
        /** Omitted unless true — the server treats absence as "leave alone". */
        val photos: Boolean? = null,
        @SerialName("resync_ebay_fields") val resyncEbayFields: Boolean? = null,
    )

    @Serializable
    private data class PushRequest(
        @SerialName("inventory_item_id") val inventoryItemId: String,
        /** Omitted unless true, so a normal first publish is byte-identical. */
        val relist: Boolean? = null,
    )

    companion object {
        const val VALIDATE_PATH = "/api/flipdesk/ebay/listings/validate"
        const val PUSH_PATH = "/api/flipdesk/ebay/listings/push"

        // US-2490: what a seller can do to a listing AFTER it is live.
        const val LISTINGS_PATH = "/api/flipdesk/ebay/listings"

        fun pricePath(listingId: String) = "$LISTINGS_PATH/$listingId/price"
        fun revisePath(listingId: String) = "$LISTINGS_PATH/$listingId/revise"
        fun endPath(listingId: String) = "$LISTINGS_PATH/$listingId"

        /** Maps a typed transport error onto the publish vocabulary. Pure. */
        fun outcome(error: EdgeApiError, json: Json): PublishOutcome = when (error) {
            // A plan/capacity wall. The server's copy names the actual limit and
            // what lifts it, so it beats anything generic we could write.
            is EdgeApiError.UpgradeRequired -> PublishOutcome.PlanLimit(error.userMessage())
            // US-1374: a 402 plan wall is the same news in a different shape.
            is EdgeApiError.PlanGated -> PublishOutcome.PlanLimit(error.userMessage())
            // 409 offer_not_open: no live offer to act on.
            is EdgeApiError.OfferNotOpen -> PublishOutcome.NoOfferId
            is EdgeApiError.BadRequest ->
                PublishBodies.blockers(error.body, json)?.let(PublishOutcome::Blockers)
                    ?: PublishOutcome.Failed(error.userMessage())

            else -> PublishOutcome.Failed(error.userMessage())
        }
    }

    /** Pre-flight. Touches nothing on eBay — safe to run on every composer load. */
    suspend fun validate(inventoryItemId: String): PublishOutcome = post(
        path = VALIDATE_PATH,
        body = edge.json.encodeToString(
            ValidateRequest.serializer(),
            ValidateRequest(inventoryItemId),
        ),
    ) { raw ->
        PublishOutcome.Validated(edge.json.decodeFromString(ValidateResponse.serializer(), raw))
    }

    /**
     * Publishes the item to eBay.
     *
     * Pass [relist] when the item was listed before: the server ends a
     * still-live listing FIRST so this mints a new listing instead of adopting
     * the old one.
     */
    suspend fun push(inventoryItemId: String, relist: Boolean = false): PublishOutcome = post(
        path = PUSH_PATH,
        body = edge.json.encodeToString(
            PushRequest.serializer(),
            PushRequest(inventoryItemId, relist.takeIf { it }),
        ),
    ) { raw ->
        PublishOutcome.Pushed(edge.json.decodeFromString(PushResponse.serializer(), raw))
    }

    /**
     * US-2490: change one live listing's price.
     *
     * Its own endpoint rather than a one-field revise: the server pushes the
     * offer price without re-asserting the title, description, photos or
     * specifics, so a price drop cannot accidentally republish a draft edit
     * the seller had not finished.
     */
    suspend fun setPrice(listingId: String, price: Double): PublishOutcome = post(
        path = pricePath(listingId),
        body = edge.json.encodeToString(PriceRequest.serializer(), PriceRequest(price)),
    ) { PublishOutcome.Done }

    /**
     * Push saved edits to a live listing.
     *
     * `resyncEbayFields` re-asserts the eBay-OWNED structured fields — category,
     * condition and item specifics — which is what makes a specifics edit made
     * on the phone (US-2413) actually reach the live listing rather than sitting
     * in the database waiting for a relist.
     */
    suspend fun revise(
        listingId: String,
        title: String? = null,
        description: String? = null,
        price: Double? = null,
        photos: Boolean = false,
        resyncEbayFields: Boolean = false,
    ): PublishOutcome = post(
        path = revisePath(listingId),
        body = edge.json.encodeToString(
            ReviseRequest.serializer(),
            ReviseRequest(
                title = title?.trim()?.takeIf { it.isNotEmpty() },
                description = description?.trim()?.takeIf { it.isNotEmpty() },
                listingPrice = price,
                photos = photos.takeIf { it },
                resyncEbayFields = resyncEbayFields.takeIf { it },
            ),
        ),
    ) { PublishOutcome.Done }

    /**
     * End a live listing.
     *
     * DELETE, and the server always reconciles the local row even when the
     * withdraw fails because the offer was already not live — a listing eBay
     * removed for a policy issue would otherwise be stuck "active" forever with
     * End as a no-op. Only a transient failure blocks it, so a retry is real.
     */
    suspend fun endListing(listingId: String): PublishOutcome = try {
        edge.deleteRaw(endPath(listingId))
        PublishOutcome.Done
    } catch (error: EdgeApiError) {
        Telemetry.breadcrumb("end listing failed: ${error.userMessage()}", category = "ebay")
        outcome(error, edge.json)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        PublishOutcome.Failed(error.message ?: "eBay wouldn't accept that.")
    }

    private suspend fun post(
        path: String,
        body: String,
        decode: (String) -> PublishOutcome,
    ): PublishOutcome = try {
        decode(edge.postRaw(path, body))
    } catch (error: EdgeApiError) {
        Telemetry.breadcrumb("publish $path failed: ${error.userMessage()}", category = "ebay")
        outcome(error, edge.json)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        // A malformed 200 lands here. "Couldn't read the response" rather than
        // "publish failed": the publish may well have gone through, and telling
        // the seller it didn't is how an item gets listed twice.
        PublishOutcome.Failed(
            error.message?.let { "Couldn't read eBay's response: $it" }
                ?: "Couldn't read eBay's response.",
        )
    }
}
