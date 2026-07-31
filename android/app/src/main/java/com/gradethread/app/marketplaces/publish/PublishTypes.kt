package com.gradethread.app.marketplaces.publish

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1352: the publish wire shapes.
 *
 * A deliberate SUBSET of what the edge returns. `/listings/validate` also
 * carries aspect diagnostics, recommended-aspect coverage and the quality
 * score; those belong to the surfaces that act on them (US-1353 and later), and
 * decoding fields nothing reads would imply Android supports them. The decoder
 * ignores unknown keys, so the extras cost nothing.
 */
@Serializable
data class ValidateResponse(
    val ok: Boolean = false,
    /** Hard stops. Empty means the item is publishable. */
    val blockers: List<String> = emptyList(),
    /** Non-blocking title-quality / picture-standards nudges. */
    val warnings: List<String> = emptyList(),
    val summary: PublishSummary? = null,
)

/** What the server would actually send to eBay — the review step's content. */
@Serializable
data class PublishSummary(
    val title: String = "",
    val description: String = "",
    val condition: String? = null,
    val conditionDescription: String? = null,
    /** eBay wants string-typed money, so this arrives as a string. */
    val priceValue: String = "",
    val currency: String? = null,
    val quantity: Int? = null,
    val categoryId: String? = null,
)

/** 200 from `/listings/push`. */
@Serializable
data class PushResponse(
    val ok: Boolean = false,
    @SerialName("listing_id") val listingId: String = "",
    @SerialName("listing_url") val listingUrl: String = "",
    @SerialName("offer_id") val offerId: String = "",
    val sku: String = "",
    /**
     * True → live on eBay but the local mirror hasn't synced yet. The UI says
     * "live, syncing shortly" rather than treating it as a failure (US-783).
     */
    @SerialName("sync_pending") val syncPending: Boolean = false,
)

/** 422 from either endpoint: publishable-blocking problems, not an error. */
@Serializable
private data class BlockersBody(
    val ok: Boolean = false,
    val blockers: List<String> = emptyList(),
)

/**
 * The typed result of a publish call.
 *
 * A sealed result rather than a thrown error because the interesting cases —
 * blockers (422), no offer id (409), a plan wall (402) — are not failures the
 * user can retry their way out of, and a raw HTTP error collapses them into one
 * unhelpful message.
 */
sealed interface PublishOutcome {
    data class Validated(val response: ValidateResponse) : PublishOutcome
    data class Pushed(val response: PushResponse) : PublishOutcome

    /** Pre-flight said no. These are fixable, and each names its fix. */
    data class Blockers(val blockers: List<String>) : PublishOutcome

    /** The listing has no eBay offer to act on (imported, or never published). */
    data object NoOfferId : PublishOutcome

    /** A plan or capacity wall — the server's copy names the limit. */
    data class PlanLimit(val message: String) : PublishOutcome

    data class Failed(val message: String) : PublishOutcome
}

internal object PublishBodies {
    /**
     * Blockers out of a 422 body. Returns null when the body isn't a blockers
     * payload, so the caller falls back to the generic error message instead of
     * showing an empty "fix these" list.
     */
    fun blockers(raw: String?, json: kotlinx.serialization.json.Json): List<String>? {
        if (raw.isNullOrBlank()) return null
        return runCatching { json.decodeFromString(BlockersBody.serializer(), raw).blockers }
            .getOrNull()
            ?.takeIf { it.isNotEmpty() }
    }
}
