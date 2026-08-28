package com.gradethread.app.inventory

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2411: `POST /api/flipdesk/ai/listing-copy` and
 * `POST /api/flipdesk/ai/extract-aspects`.
 *
 * **Both take an item id and nothing else.** The server loads the photos
 * itself, so the phone sends no URLs and the two calls cost one round trip
 * each. The consequence worth knowing is the other way round: an item that has
 * not synced yet has no photos on the server, and both routes answer 404 —
 * which is why [ITEM_NOT_SYNCED] exists rather than showing the seller a bare
 * "Item not found".
 *
 * **Neither route writes anything to the item.** They propose, log the
 * proposal, and return. Persistence is the client's, which is what makes the
 * accept step real rather than decorative.
 */
@Serializable
data class ListingCopy(
    val title: String = "",
    val description: String = "",
    val model: String? = null,
    @SerialName("log_id") val logId: String? = null,
    /** -1 means unlimited. What is LEFT after this call, not before it. */
    @SerialName("actions_remaining") val actionsRemaining: Int = 0,
) {
    /** Nothing to offer — an empty answer must never overwrite real copy. */
    val isUsable: Boolean get() = title.isNotBlank() || description.isNotBlank()
}

@Serializable
data class AspectSuggestion(
    val values: List<String> = emptyList(),
    val confidence: Double = 0.0,
    /** Where the model says it read the value — "photo", "title", and so on. */
    val source: String = "",
)

@Serializable
data class ExtractedAspects(
    @SerialName("category_id") val categoryId: String? = null,
    val suggestions: Map<String, AspectSuggestion> = emptyMap(),
    /**
     * Null on the free early return, when the category exposes no fillable
     * specifics at all. That branch spends no AI action, so it is a real
     * answer rather than a failure.
     */
    val model: String? = null,
    @SerialName("log_id") val logId: String? = null,
    @SerialName("actions_remaining") val actionsRemaining: Int = 0,
    @SerialName("aspects_considered") val aspectsConsidered: Int = 0,
    @SerialName("aspects_available") val aspectsAvailable: Int = 0,
)

@Serializable
private data class ItemIdRequest(@SerialName("item_id") val itemId: String)

@Serializable
private data class ExtractAspectsRequest(
    @SerialName("item_id") val itemId: String,
    @SerialName("category_id") val categoryId: String? = null,
    /**
     * What the item already has. Sent so the model does not spend its answer
     * re-proposing values the seller has already filled in.
     */
    @SerialName("known_aspects") val knownAspects: Map<String, List<String>>? = null,
)

@Singleton
class ListingCopyService @Inject constructor(
    /**
     * The long-idle profile. Aspect extraction reads every photo on the item
     * against a category's whole specifics list and routinely runs past the
     * 20s shared cap, which the seller would read as "it didn't work".
     */
    @Named("ai") private val edge: EdgeApi,
) {

    /** Write a title and description from the item's photos. One AI action. */
    suspend fun listingCopy(itemId: String): ListingCopy = decode(
        ListingCopy.serializer(),
        edge.postRaw(
            LISTING_COPY_PATH,
            json.encodeToString(ItemIdRequest.serializer(), ItemIdRequest(itemId)),
        ),
    )

    /** Propose item specifics from the photos. One AI action. */
    suspend fun extractAspects(
        itemId: String,
        categoryId: String? = null,
        knownAspects: Map<String, List<String>> = emptyMap(),
    ): ExtractedAspects = decode(
        ExtractedAspects.serializer(),
        edge.postRaw(
            EXTRACT_ASPECTS_PATH,
            json.encodeToString(
                ExtractAspectsRequest.serializer(),
                ExtractAspectsRequest(
                    itemId = itemId,
                    categoryId = categoryId?.takeIf { it.isNotBlank() },
                    knownAspects = knownAspects.takeIf { it.isNotEmpty() },
                ),
            ),
        ),
    )

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, raw: String): T =
        try {
            json.decodeFromString(serializer, raw)
        } catch (t: Throwable) {
            throw EdgeApiError.Decoding(t.message ?: "unreadable AI response", t)
        }

    companion object {
        const val LISTING_COPY_PATH = "/api/flipdesk/ai/listing-copy"
        const val EXTRACT_ASPECTS_PATH = "/api/flipdesk/ai/extract-aspects"

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * A 404 from either route means the item is not on the server yet.
         *
         * The server's own words are "Item not found", which reads as data
         * loss. The item is on the phone; it is the photos the model needs
         * that have not been uploaded, and the fix is to wait or to sync.
         */
        const val ITEM_NOT_SYNCED =
            "This item hasn't finished syncing yet. Give the photos a moment to upload, then try again."

        fun message(error: Throwable): String = when (error) {
            is EdgeApiError.NotFound -> ITEM_NOT_SYNCED
            is EdgeApiError -> error.userMessage()
            else -> error.message ?: "The AI couldn't answer just now."
        }
    }
}
