package com.gradethread.app.analytics

import com.gradethread.app.sync.RealtimeRows
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Singleton

@Serializable
private data class RemotePerformanceRow(
    val id: String,
    @SerialName("inventory_item_id") val inventoryItemId: String,
    @SerialName("listing_title") val listingTitle: String? = null,
    @SerialName("listing_url") val listingUrl: String? = null,
    @SerialName("listing_price") val listingPrice: Double? = null,
    @SerialName("listed_at") val listedAt: String? = null,
    @SerialName("views_total") val viewsTotal: Int? = null,
    @SerialName("watchers_count") val watchersCount: Int? = null,
    @SerialName("impressions_7d") val impressions7d: Int? = null,
    @SerialName("click_through_rate") val clickThroughRate: Double? = null,
    @SerialName("last_metrics_synced_at") val lastMetricsSyncedAt: String? = null,
)

@Serializable
private data class RemoteConnectionRow(
    @SerialName("analytics_access_denied") val analyticsAccessDenied: Boolean? = null,
)

/**
 * US-1368: reads the listing-performance rows straight from `listings` through
 * the RLS-scoped client.
 *
 * No dedicated edge route: this is the same source the web page uses, and RLS
 * already restricts it to the signed-in user's rows, so adding a route would be
 * a second thing to keep in step for no isolation gain.
 *
 * Behind an interface because the screen's behaviour — the denied-scope banner,
 * the empty state, the sort — is worth testing without a network.
 */
interface ListingPerformanceProviding {
    suspend fun rows(): List<ListingPerformanceRow>

    /**
     * Whether eBay refused Sell Analytics scope for the active connection.
     * Null means there is no active eBay connection at all, which is a
     * different (and more fixable) problem than a denied scope.
     */
    suspend fun analyticsDenied(): Boolean?
}

@Singleton
class ListingPerformanceService @Inject constructor(
    private val client: SupabaseClient,
) : ListingPerformanceProviding {

    override suspend fun rows(): List<ListingPerformanceRow> = client
        .from("listings")
        .select(Columns.raw(COLUMNS)) {
            filter {
                eq("platform", "ebay")
                eq("listing_status", "active")
            }
            order("views_total", Order.DESCENDING)
            limit(MAX_ROWS)
        }
        .decodeList<RemotePerformanceRow>()
        .map { row ->
            ListingPerformanceRow(
                id = row.id,
                inventoryItemId = row.inventoryItemId,
                title = row.listingTitle,
                listingUrl = row.listingUrl,
                listingPrice = row.listingPrice ?: 0.0,
                listedAtMs = RealtimeRows.parseTimestamp(row.listedAt),
                // Nulls on a row synced before any metrics pull ran are zero
                // views, not missing data we should hide.
                viewsTotal = row.viewsTotal ?: 0,
                watchersCount = row.watchersCount ?: 0,
                impressions7d = row.impressions7d ?: 0,
                clickThroughRate = row.clickThroughRate,
                lastMetricsSyncedAtMs = RealtimeRows.parseTimestamp(row.lastMetricsSyncedAt),
            )
        }

    override suspend fun analyticsDenied(): Boolean? = client
        .from("marketplace_connections")
        .select(Columns.raw("analytics_access_denied")) {
            filter {
                eq("marketplace", "ebay")
                eq("is_active", true)
            }
            order("updated_at", Order.DESCENDING)
            limit(1)
        }
        .decodeList<RemoteConnectionRow>()
        .firstOrNull()
        ?.let { it.analyticsAccessDenied ?: false }

    private companion object {
        const val MAX_ROWS = 1000L
        const val COLUMNS =
            "id, inventory_item_id, listing_title, listing_url, listing_price, listed_at, " +
                "views_total, watchers_count, impressions_7d, click_through_rate, " +
                "last_metrics_synced_at"
    }
}
