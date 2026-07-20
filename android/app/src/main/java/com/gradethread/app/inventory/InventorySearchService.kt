package com.gradethread.app.inventory

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1342: server-side full-text search over inventory (iOS
 * `InventorySearchService`).
 *
 * Strictly ADDITIVE to the local token search. Local search always runs; a
 * server hit can only widen the result set, never narrow it. Any failure —
 * offline, signed out, RPC error — resolves to null and local search stands
 * alone, because a search box that goes blank when the network hiccups is
 * worse than one that misses a fuzzy match.
 */
@Singleton
class InventorySearchService @Inject constructor(private val client: SupabaseClient) {

    companion object {
        /** Below this the tsquery is noise and not worth a round trip. */
        const val MIN_QUERY_LENGTH = 2
        const val RESULT_LIMIT = 100
        private const val RPC = "flipdesk_search"
    }

    /** Guards against a slow response for an abandoned query overwriting a newer one. */
    @Volatile
    private var lastQuery: String? = null

    /**
     * @return matching item ids, or null when the search didn't run or
     * failed. Null means "no server opinion", NOT "no matches" — the two
     * must not be conflated or a failed RPC would empty the list.
     */
    suspend fun search(query: String): Set<String>? {
        val trimmed = query.trim()
        if (trimmed.length < MIN_QUERY_LENGTH) {
            lastQuery = null
            return null
        }
        lastQuery = trimmed

        return runCatching {
            val rows = client.postgrest.rpc(
                function = RPC,
                parameters = JsonObject(
                    mapOf(
                        "p_query" to JsonPrimitive(trimmed),
                        "p_scope" to JsonPrimitive("items"),
                        "p_limit" to JsonPrimitive(RESULT_LIMIT),
                    ),
                ),
            ).decodeList<SearchRow>()

            // Discard a stale response: the user has typed on since this
            // request went out, and applying it would flash old results.
            if (trimmed != lastQuery) return@runCatching null

            rows.mapNotNull { it.inventoryItemId }.toSet()
        }.getOrNull()
    }
}

@Serializable
private data class SearchRow(
    @SerialName("inventory_item_id") val inventoryItemId: String? = null,
)
