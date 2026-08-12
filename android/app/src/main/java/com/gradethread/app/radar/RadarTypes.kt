package com.gradethread.app.radar

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-2492: the read models for the SHARED half of Sourcing Radar.
 *
 * Sibling of [MyStores], and the difference between the two files is the whole
 * feature. `my-stores` is one reseller's own history, free and true at n=1.
 * Everything here is an aggregate of other people's scans, served only once
 * enough different people have contributed, and it arrives with a k-anonymity
 * floor already applied server-side (`routes/flipdesk-radar.ts`).
 *
 * Nothing on these types can name, key or order a contributor. That is a
 * property of the endpoint rather than of this file; the client's only job is to
 * avoid inventing what the server withheld - which is why a missing row is
 * modelled as ABSENT rather than as a zero.
 *
 * Every field carries a default so a server that adds one cannot break decoding
 * mid-release, matching [MyStores] and iOS `RadarTypes.swift`.
 */

/** The activity windows the aggregation job publishes. The server's vocabulary. */
enum class RadarWindow(val wire: String) {
    SEVEN_DAYS("7d"),
    THIRTY_DAYS("30d"),
    NINETY_DAYS("90d"),
    ;

    companion object {
        val DEFAULT = THIRTY_DAYS
    }
}

/** Condition mix at a venue. Counts, never a per-scan list. */
@Serializable
data class RadarGradeMix(
    val high: Int = 0,
    val mid: Int = 0,
    val low: Int = 0,
    val ungraded: Int = 0,
) {
    /**
     * Scans that carried a grade. Zero means there is no condition picture,
     * which is a different statement from "everything found here was rough".
     */
    val graded: Int get() = high + mid + low
}

/**
 * One served aggregate row: a venue's activity for one window and one brand key
 * ([brand] null is the venue total).
 */
@Serializable
data class RadarNetworkStats(
    @SerialName("venue_id") val venueId: String = "",
    val window: String = "",
    /** Null for the all-brands total. */
    val brand: String? = null,
    @SerialName("scan_count") val scanCount: Int = 0,
    @SerialName("contributor_count") val contributorCount: Int = 0,
    @SerialName("avg_grade") val avgGrade: Double? = null,
    @SerialName("buy_rate") val buyRate: Double? = null,
    @SerialName("grade_mix") val gradeMix: RadarGradeMix = RadarGradeMix(),
    /** Seven counts, index 0 = Sunday, in the venue's approximate local time. */
    @SerialName("activity_by_day") val activityByDay: List<Int> = emptyList(),
    @SerialName("last_activity_at") val lastActivityAt: String? = null,
    /** Null when the row carries no usable timestamp. Not zero: zero is "today". */
    @SerialName("days_since_activity") val daysSinceActivity: Int? = null,
)

/**
 * A venue as the list endpoint serves it.
 *
 * [lat]/[lng] are a geohash CELL CENTRE, identical for everyone in that cell
 * (US-1862), so they place a shop on a list and are not a record of where
 * anybody stood.
 */
@Serializable
data class RadarVenue(
    val id: String = "",
    @SerialName("display_name") val displayName: String = "",
    val chain: String? = null,
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    val status: String = "active",
    val network: RadarNetworkStats = RadarNetworkStats(),
)

@Serializable
data class RadarVenuesPayload(
    val window: String = "",
    val brand: String? = null,
    /** How many different people must have scanned somewhere before it appears. */
    @SerialName("k_floor") val kFloor: Int = 0,
    val venues: List<RadarVenue> = emptyList(),
)

/** The venue half of the detail payload. `network` is a sibling, not a field. */
@Serializable
data class RadarVenueSummary(
    val id: String = "",
    @SerialName("display_name") val displayName: String = "",
    val chain: String? = null,
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    val status: String = "active",
)

@Serializable
data class RadarVenueDetail(
    val window: String = "",
    @SerialName("k_floor") val kFloor: Int = 0,
    val venue: RadarVenueSummary = RadarVenueSummary(),
    val network: RadarNetworkStats = RadarNetworkStats(),
    /**
     * Per-brand rows that individually cleared the floor, busiest first. A brand
     * missing here is a brand we cannot speak about, not a brand absent from the
     * shop.
     */
    val brands: List<RadarNetworkStats> = emptyList(),
)
