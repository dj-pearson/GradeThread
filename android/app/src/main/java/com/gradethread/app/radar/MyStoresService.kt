package com.gradethread.app.radar

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.Locale
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2495: which shops actually make this seller money.
 *
 * The PERSONAL half of Sourcing Radar. It needs no location permission and no
 * map, because it is not about where you are — it is about where your stock
 * came from and what it did afterwards.
 *
 * **Nothing here is shared, and nothing here is aggregated.** These are the
 * caller's own sources joined to their own items and sales. The shared venue
 * layer is a different endpoint with a k-anonymity floor in front of it; this
 * one has no floor because there is no one to protect it from.
 */
@Serializable
data class StoreBrand(
    val brand: String = "",
    val items: Int = 0,
    @SerialName("realized_profit_cents") val realizedProfitCents: Long = 0,
)

@Serializable
data class MyStore(
    /** Source id, or `venue:<id>` for a shop with visits but no source row. */
    val key: String = "",
    @SerialName("source_id") val sourceId: String? = null,
    @SerialName("venue_id") val venueId: String? = null,
    val name: String = "",
    @SerialName("source_type") val sourceType: String? = null,
    val location: String? = null,
    val chain: String? = null,
    val lat: Double? = null,
    val lng: Double? = null,
    /** True once this store is joined to a shared Radar venue. */
    val linked: Boolean = false,
    @SerialName("items_sourced") val itemsSourced: Int = 0,
    @SerialName("items_sold") val itemsSold: Int = 0,
    @SerialName("spend_cents") val spendCents: Long = 0,
    @SerialName("sold_spend_cents") val soldSpendCents: Long = 0,
    @SerialName("realized_profit_cents") val realizedProfitCents: Long = 0,
    @SerialName("expected_profit_cents") val expectedProfitCents: Long = 0,
    /** Null when nothing has been spent — never rendered as 0%. */
    @SerialName("roi_pct") val roiPct: Double? = null,
    /** Null until something has actually sold. */
    @SerialName("realized_roi_pct") val realizedRoiPct: Double? = null,
    @SerialName("sell_through_pct") val sellThroughPct: Double? = null,
    @SerialName("top_brands") val topBrands: List<StoreBrand> = emptyList(),
)

@Serializable
data class MyStores(
    val stores: List<MyStore> = emptyList(),
    /**
     * Visits the registry could not place. Reported as a number rather than
     * folded into a fake "Unknown store" row — a shop nobody can go back to is
     * not a shop.
     */
    @SerialName("unplaced_visits") val unplacedVisits: Int = 0,
    /** Items with no source, so attributable to nowhere. */
    @SerialName("unattributed_items") val unattributedItems: Int = 0,
    val sort: String = "",
    /** A read hit its cap. Said out loud rather than implying completeness. */
    val truncated: Boolean = false,
)

@Singleton
class MyStoresService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    suspend fun stores(sort: StoreSort = StoreSort.PROFIT): MyStores =
        json.decodeFromString(
            MyStores.serializer(),
            edge.getRaw(PATH, mapOf("sort" to sort.wire)),
        )

    companion object {
        const val PATH = "/api/flipdesk/radar/my-stores"

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        fun message(error: Throwable): String =
            (error as? EdgeApiError)?.userMessage()
                ?: error.message
                ?: "We couldn't load your store history just now."
    }
}

/** The orders the server accepts. Its vocabulary, not a second one. */
enum class StoreSort(val wire: String) {
    PROFIT("profit"),
    ROI("roi"),
    ITEMS("items"),
    RECENT("recent"),
}

/** Presentation rules for the store list. Pure, so they are testable. */
object MyStoresRules {

    fun dollars(cents: Long): Double = cents / 100.0

    /**
     * Whether a percentage is worth printing.
     *
     * The server sends null for "nothing has sold yet" and for "nothing has
     * been spent". Rendering either as 0% would report a shop that has not had
     * a chance yet as a shop that failed.
     */
    fun hasFigure(pct: Double?): Boolean = pct != null

    /**
     * A percentage, to one decimal place, in the reader's locale.
     *
     * Formatted here rather than by a `%1$.1f` in the resource, which
     * `check-string-formats.py` cannot see: its placeholder scan only knows
     * `%n$s` and `%n$d`, so the float form read as "takes no arguments" and the
     * call that passed one failed the guard on every run.
     */
    fun percent(pct: Double, locale: Locale = Locale.getDefault()): String =
        String.format(locale, "%.1f", pct)

    /**
     * The stores worth showing at the top of a phone screen.
     *
     * Already sorted by the server, so this only takes — re-sorting here would
     * be a second opinion about "best" that the sort control does not control.
     */
    fun top(stores: List<MyStore>, limit: Int = 20): List<MyStore> = stores.take(limit)

    /**
     * Whether the totals can be trusted as complete.
     *
     * A truncated read is not an error, but a seller comparing two shops needs
     * to know one of them may be missing items.
     */
    fun isComplete(stores: MyStores): Boolean = !stores.truncated
}
