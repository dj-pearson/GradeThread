package com.gradethread.app.inventory

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2413: fold specifics-editor edits back into the item's own columns.
 *
 * **Brand, Size, Color, Material and Style are single-entry, and the COLUMN is
 * the write-authority at publish.** So a Brand typed in the specifics editor
 * that never reached `inventory_items.brand` was not merely unsynced: the next
 * ordinary item save projected the empty column forward and wiped it, and the
 * seller had to type the same value in two places to make it stick.
 *
 * The mapping from aspect name to column lives in ONE place, the server's
 * aspect registry, and this call is how a non-web client reaches it. Shipping a
 * second mapping table on the phone is exactly the drift the registry exists to
 * prevent.
 */
@Serializable
data class AspectWriteBackResult(
    /** Column name to its new value. Empty when nothing needed changing. */
    val updated: Map<String, String?> = emptyMap(),
)

@Singleton
class AspectWriteBackService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    suspend fun writeBack(
        itemId: String,
        aspects: Map<String, List<String>>,
        sources: Map<String, AspectSync.Provenance>,
    ): AspectWriteBackResult = json.decodeFromString(
        AspectWriteBackResult.serializer(),
        edge.postRaw(PATH, payload(itemId, aspects, sources).toString()),
    )

    companion object {
        const val PATH = "/api/flipdesk/ebay/aspects/write-back"

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * The request body, and the same bytes the offline queue replays.
         *
         * **Every value of a multi-value aspect goes, not just the first.** The
         * server decides per registry entry whether a field takes one value or
         * the whole list; a client that sent only `values[0]` would silently
         * turn a three-value Features specific into a one-value one, and the
         * loss would only show up on the live listing.
         *
         * Provenance goes too and is not cosmetic: the server refuses to write
         * back anything that is not `manual` or `ai_extracted`, which is what
         * stops a value the item's own column derived from being written back
         * onto that same column in a loop.
         */
        fun payload(
            itemId: String,
            aspects: Map<String, List<String>>,
            sources: Map<String, AspectSync.Provenance>,
        ): JsonObject = buildJsonObject {
            put("itemId", JsonPrimitive(itemId))
            put(
                "aspects",
                JsonObject(
                    aspects
                        .mapValues { (_, values) ->
                            JsonArray(
                                values.map { it.trim() }
                                    .filter { it.isNotEmpty() }
                                    .map(::JsonPrimitive),
                            )
                        }
                        .filterValues { it.isNotEmpty() },
                ),
            )
            put(
                "sources",
                JsonObject(sources.mapValues { JsonPrimitive(it.value.wire) }),
            )
        }
    }
}
