package com.gradethread.app.marketplaces

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2481 AC1: the phone's half of the auto-delist queue.
 *
 * When a cross-listed item sells, the edge ends its siblings. On eBay, Shopify
 * and Depop it does that itself. On the extension channels there is no write
 * API, so all it can do is STAMP the listing (`listings.delist_requested_at`)
 * and wait for a browser — see
 * `vault/60-decisions/adr-no-server-side-marketplace-automation.md`.
 *
 * That stamp has existed since US-717 and only the web dashboard ever read it.
 * A seller who sold on eBay while out sourcing had no way, on the device they
 * actually had, to see that their Poshmark copy was still live — which is the
 * double sale the queue exists to prevent, left in place on the phone.
 *
 * Two outs are offered here, in order of honesty. Queue the delist for the
 * desktop extension, with [QUEUED_NOTICE] attached so nobody reads it as done.
 * Or say "I ended it myself", which clears the stamp and is the only path for a
 * row the extension can never end. Ending a listing FROM the phone is not
 * offered, because there is no mechanism to; claiming otherwise is what the ADR
 * refuses.
 */
@Serializable
data class PendingDelist(
    @SerialName("listing_id") val listingId: String,
    val platform: String,
    @SerialName("listing_url") val listingUrl: String? = null,
    /**
     * `draft` means GradeThread only prefilled this listing and never confirmed
     * it went live. Distinct from "no URL", and it needs different words:
     * telling a seller "no saved URL" for something that may never have been
     * published sends them hunting for nothing.
     */
    @SerialName("listing_status") val listingStatus: String? = null,
    /** Confirmed live AND has a URL — the only rows the extension can end. */
    @SerialName("auto_delistable") val autoDelistable: Boolean? = null,
    @SerialName("item_id") val itemId: String,
    @SerialName("item_title") val itemTitle: String? = null,
    @SerialName("requested_at") val requestedAt: String? = null,
)

@Serializable
private data class PendingDelistResponse(val pending: List<PendingDelist> = emptyList())

@Serializable
private data class DelistConfirmBody(@SerialName("listing_id") val listingId: String)

/**
 * The channels the desktop extension can actually end a listing on. Mirrors
 * `LISTER_EXTENSION_PLATFORMS` in `src/lib/lister-extension.ts`.
 */
val EXTENSION_DELIST_PLATFORMS: Set<String> =
    setOf("poshmark", "mercari", "grailed", "vinted", "facebook")

/**
 * Why a row cannot be queued for the desktop, in the seller's words. Null means
 * it can be. Mirrors the degrade order in the web's `useRunDelist`.
 *
 * A top-level function so a unit test can hold the copy without an [EdgeApi]:
 * wording only a UI can reach is wording only a human can check.
 */
fun pendingDelistBlockedReason(row: PendingDelist): String? = when {
    row.platform !in EXTENSION_DELIST_PLATFORMS ->
        "The extension doesn't handle ${row.platform}. End this listing on the marketplace."

    row.listingStatus == "draft" ->
        "GradeThread only prefilled this listing and never confirmed it went live. " +
            "Check the marketplace, and if you did publish it, end it there."

    row.listingUrl.isNullOrBlank() ->
        "No saved listing URL, so nothing can open it for you. " +
            "End this listing on the marketplace."

    else -> null
}

/** How one pending delist reads in a list. */
fun describePendingDelist(row: PendingDelist): String {
    val label = EXTENSION_CHANNEL_LABELS[row.platform]
        ?: row.platform.replaceFirstChar { it.uppercase() }
    return "${row.itemTitle ?: "Untitled item"} — still live on $label"
}

internal val EXTENSION_CHANNEL_LABELS = mapOf(
    "poshmark" to "Poshmark",
    "mercari" to "Mercari",
    "grailed" to "Grailed",
    "vinted" to "Vinted",
    "facebook" to "Facebook Marketplace",
)

@Singleton
class PendingDelistRepository @Inject constructor(
    // NetworkModule binds TWO EdgeApi profiles ("shared" and "ai"), so an
    // unqualified EdgeApi has no binding and Dagger fails the build rather than
    // picking one. This is an ordinary API call: "shared".
    @Named("shared") private val edgeApi: EdgeApi,
    private val extensionQueue: ExtensionQueueRepository,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private companion object {
        const val PENDING_PATH = "/api/flipdesk/listings/pending-delists"
        const val CONFIRM_PATH = "/api/flipdesk/listings/delist-confirm"
    }

    /** Listings that sold elsewhere and are still up. */
    suspend fun pending(): List<PendingDelist> {
        val raw = edgeApi.getRaw(PENDING_PATH)
        return json.decodeFromString(PendingDelistResponse.serializer(), raw).pending
    }

    /**
     * Queue the end-this-listing instruction for the desktop extension.
     *
     * Refuses rather than queueing a row the drain cannot run: a queued job
     * that will be rejected is worse than no job, because it reads as handled.
     */
    suspend fun queueForDesktop(row: PendingDelist): Result<ExtensionQueueItem> {
        pendingDelistBlockedReason(row)?.let {
            return Result.failure(IllegalStateException(it))
        }
        return runCatching {
            extensionQueue.enqueue(
                kind = ExtensionQueueKind.DELIST,
                platform = row.platform,
                inventoryItemId = row.itemId,
                listingId = row.listingId,
                // The extension re-checks this against its own bundled host
                // list before opening anything (US-1876). Sending it is how the
                // drain knows WHICH listing; it is not what makes it trusted.
                payload = mapOf("listingUrl" to (row.listingUrl ?: "")),
            )
        }
    }

    /**
     * "I ended it myself." Clears the stamp so the row stops nagging.
     *
     * Only ever driven by the seller saying they did it. Nothing here infers
     * it, because a stamp cleared on a listing that is still live is exactly
     * the silence that produces a double sale.
     */
    suspend fun markEndedManually(listingId: String): Result<Unit> = runCatching {
        edgeApi.postRaw(
            CONFIRM_PATH,
            json.encodeToString(DelistConfirmBody.serializer(), DelistConfirmBody(listingId)),
        )
        Unit
    }
}
