package com.gradethread.app.inventory

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * US-1346: eBay comps.
 *
 * Two hops, because the comps search needs a leaf category and an item only
 * has a title: `GET /ebay/category/suggest?q=` resolves the category, then
 * `GET /ebay/comps?category_id=…` returns the percentile rollup.
 */
@Serializable
data class CompStats(
    val count: Int = 0,
    val currency: String = "USD",
    val min: Double? = null,
    val p25: Double? = null,
    val median: Double? = null,
    val p75: Double? = null,
    val max: Double? = null,
) {
    /**
     * Whether there is a median worth acting on.
     *
     * `count > 0` alone is NOT enough — every percentile is independently
     * nullable, so a result can report comparable listings and still have no
     * median. Offering "use median" then would write null into the price field.
     */
    val hasMedian: Boolean get() = median != null && median > 0.0
}

@Serializable
data class CompsResponse(val stats: CompStats = CompStats())

@Serializable
data class CategorySuggestion(
    val categoryId: String = "",
    val categoryName: String = "",
    val categoryTreePath: String = "",
)

@Serializable
data class CategorySuggestResponse(
    val suggestions: List<CategorySuggestion> = emptyList(),
    /**
     * US-1559: eBay's Taxonomy API intermittently 500s, and the edge degrades
     * to an empty list rather than a 502 the client would retry into. It is a
     * DIFFERENT state from "no category matches" and must read differently —
     * one is worth retrying in a minute, the other never will be.
     */
    val degraded: Boolean = false,
)

/** A resolved lookup: the stats plus the category they were drawn from. */
data class CompsLookup(
    val stats: CompStats,
    val categoryId: String,
    val categoryPath: String,
)

/** What the comps panel is showing. */
sealed class CompsState {
    object Idle : CompsState()
    object Loading : CompsState()
    data class Loaded(val lookup: CompsLookup) : CompsState()

    /** No eBay category matched the title — comps cannot be searched at all. */
    object NoCategory : CompsState()

    /** eBay's taxonomy service is degraded; retrying later may well work. */
    object Degraded : CompsState()

    data class Failed(val message: String) : CompsState()
}

/**
 * One saved comparable sale, stored in `inventory_items.comp_set` (jsonb).
 * Mirrors the web `ItemComp`.
 */
@Serializable
data class ItemComp(
    val price: Double,
    val source: String? = null,
    val url: String? = null,
    @SerialName("sold_date") val soldDate: String? = null,
    val notes: String? = null,
)

object CompSet {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    /**
     * Decode `comp_set`.
     *
     * Price is tolerated as a NUMBER OR A NUMERIC STRING, matching iOS: the
     * column has been written by several surfaces over time and a strict
     * decode would drop a seller's whole saved-comp list over one quoted
     * value. A row with no usable price is skipped rather than stored as 0 —
     * a comp of $0 would drag any average built on it.
     */
    fun decode(raw: String?): List<ItemComp> {
        if (raw.isNullOrBlank()) return emptyList()
        return runCatching {
            json.parseToJsonElement(raw).jsonArray.mapNotNull { element ->
                val obj = element as? JsonObject ?: return@mapNotNull null
                val price = obj["price"]?.let { priceOf(it) } ?: return@mapNotNull null
                if (price <= 0.0) return@mapNotNull null
                ItemComp(
                    price = price,
                    source = obj["source"]?.stringOrNull(),
                    url = obj["url"]?.stringOrNull(),
                    soldDate = obj["sold_date"]?.stringOrNull(),
                    notes = obj["notes"]?.stringOrNull(),
                )
            }
        }.getOrDefault(emptyList())
    }

    /** Encode for the jsonb column; null when there is nothing to store. */
    fun encode(comps: List<ItemComp>): String? {
        val kept = comps.filter { it.price > 0.0 }
        if (kept.isEmpty()) return null
        return JsonArray(
            kept.map { comp ->
                JsonObject(
                    buildMap {
                        put("price", JsonPrimitive(comp.price))
                        comp.source?.takeIf { it.isNotBlank() }
                            ?.let { put("source", JsonPrimitive(it)) }
                        comp.url?.takeIf { it.isNotBlank() }
                            ?.let { put("url", JsonPrimitive(it)) }
                        comp.soldDate?.takeIf { it.isNotBlank() }
                            ?.let { put("sold_date", JsonPrimitive(it)) }
                        comp.notes?.takeIf { it.isNotBlank() }
                            ?.let { put("notes", JsonPrimitive(it)) }
                    },
                )
            },
        ).toString()
    }

    /** The median of the seller's own saved comps. */
    fun median(comps: List<ItemComp>): Double? {
        val prices = comps.map { it.price }.filter { it > 0.0 }.sorted()
        if (prices.isEmpty()) return null
        val mid = prices.size / 2
        return if (prices.size % 2 == 1) {
            prices[mid]
        } else {
            (prices[mid - 1] + prices[mid]) / 2.0
        }
    }

    private fun priceOf(element: kotlinx.serialization.json.JsonElement): Double? {
        val primitive = element as? JsonPrimitive ?: return null
        primitive.doubleOrNull?.let { return it }
        // A quoted number — "42.50" — still means 42.50.
        return primitive.content.trim().toDoubleOrNull()
    }

    private fun kotlinx.serialization.json.JsonElement.stringOrNull(): String? =
        (this as? JsonPrimitive)?.contentOrNullSafe()

    private fun JsonPrimitive.contentOrNullSafe(): String? =
        content.takeIf { it.isNotBlank() && it != "null" }
}
