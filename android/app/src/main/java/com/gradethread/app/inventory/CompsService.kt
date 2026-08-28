package com.gradethread.app.inventory

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1346: the two-hop comps lookup.
 *
 *   1. `GET /api/flipdesk/ebay/category/suggest?q=` → the best leaf category
 *   2. `GET /api/flipdesk/ebay/comps?category_id=…&q=&brand=&size=` → stats
 *
 * The hop exists because eBay's Browse search needs a leaf category and an
 * inventory item only has a title.
 */
@Singleton
class CompsService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        const val SUGGEST_PATH = "/api/flipdesk/ebay/category/suggest"
        const val COMPS_PATH = "/api/flipdesk/ebay/comps"

        /**
         * The suggest query. Brand and title together — the taxonomy match is
         * much better with the brand, and an item's title alone is often just
         * "Untitled item" straight out of photo-first intake.
         */
        fun suggestQuery(title: String, brand: String?): String =
            listOfNotNull(brand?.trim()?.takeIf { it.isNotEmpty() }, title.trim())
                .joinToString(" ")
                .trim()
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /**
     * Resolve a category and fetch its comps.
     *
     * Returns a typed state rather than throwing for the two non-error
     * outcomes, because they mean different things to the seller: a degraded
     * taxonomy service is worth retrying shortly, and an unmatched title never
     * will be until the title improves.
     */
    suspend fun lookup(title: String, brand: String?, size: String?): CompsState {
        val query = suggestQuery(title, brand)
        if (query.isBlank()) return CompsState.NoCategory

        val suggestion = runCatching {
            decode(
                edge.getRaw(SUGGEST_PATH, mapOf("q" to query)),
                CategorySuggestResponse.serializer(),
            )
        }.getOrElse { return CompsState.Failed(message(it)) }

        if (suggestion.degraded) return CompsState.Degraded
        val category = suggestion.suggestions.firstOrNull()
            ?.takeIf { it.categoryId.isNotBlank() }
            ?: return CompsState.NoCategory

        val comps = runCatching {
            decode(
                edge.getRaw(
                    COMPS_PATH,
                    buildMap {
                        put("category_id", category.categoryId)
                        put("q", query)
                        brand?.trim()?.takeIf { it.isNotEmpty() }?.let { put("brand", it) }
                        size?.trim()?.takeIf { it.isNotEmpty() }?.let { put("size", it) }
                    },
                ),
                CompsResponse.serializer(),
            )
        }.getOrElse { return CompsState.Failed(message(it)) }

        return CompsState.Loaded(
            CompsLookup(
                stats = comps.stats,
                categoryId = category.categoryId,
                // Surfaced so the seller can sanity-check that the
                // auto-resolved category actually matches their item — a comp
                // range drawn from the wrong category is worse than none.
                categoryPath = category.categoryTreePath.ifBlank { category.categoryName },
            ),
        )
    }

    private fun <T> decode(raw: String, serializer: kotlinx.serialization.DeserializationStrategy<T>): T =
        try {
            json.decodeFromString(serializer, raw)
        } catch (t: Throwable) {
            throw EdgeApiError.Decoding(t.message ?: "unparseable comps response", t)
        }

    private fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Couldn't fetch comps."
}
