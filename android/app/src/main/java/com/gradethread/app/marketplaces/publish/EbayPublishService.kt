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
    private data class PushRequest(
        @SerialName("inventory_item_id") val inventoryItemId: String,
        /** Omitted unless true, so a normal first publish is byte-identical. */
        val relist: Boolean? = null,
    )

    companion object {
        const val VALIDATE_PATH = "/api/flipdesk/ebay/listings/validate"
        const val PUSH_PATH = "/api/flipdesk/ebay/listings/push"

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
