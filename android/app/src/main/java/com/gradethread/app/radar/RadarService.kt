package com.gradethread.app.radar

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2492: the two SHARED Radar reads.
 *
 * Both go through the `shared` [EdgeApi], and that buys three things this
 * surface would otherwise re-implement: the bounded retry and 401 refresh, the
 * US-1374 plan gate (the network layer is Pro+, so a Free seller gets a 402 that
 * [EdgeApi] has already turned into the upgrade dialog before the error reaches
 * a caller here), and the workspace scope header.
 *
 * This client performs NO aggregation and applies NO k-anonymity floor. Both
 * live on the server: a below-floor venue is simply ABSENT from the response
 * rather than redacted in it, so there is no suppressed payload for the phone to
 * be trusted to hide.
 */
@Singleton
class RadarService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    /**
     * The nearby list. [bbox] is the literal `minLat,minLng,maxLat,maxLng` the
     * endpoint parses, which [RadarBoundingBox.param] builds.
     *
     * Cached briefly on purpose. Panning and window-flipping re-ask the same
     * question, and the answer is a cron-published aggregate that cannot change
     * between two taps.
     */
    suspend fun venues(
        bbox: String,
        window: RadarWindow = RadarWindow.DEFAULT,
        brand: String? = null,
    ): RadarVenuesPayload {
        val query = buildMap {
            put("bbox", bbox)
            put("window", window.wire)
            brand?.takeIf { it.isNotBlank() }?.let { put("brand", it) }
        }
        return json.decodeFromString(
            RadarVenuesPayload.serializer(),
            edge.getRaw(VENUES_PATH, query, cacheTtlMillis = CACHE_TTL_MILLIS),
        )
    }

    /** One venue plus its per-brand breakdown. */
    suspend fun venueDetail(
        id: String,
        window: RadarWindow = RadarWindow.DEFAULT,
    ): RadarVenueDetail = json.decodeFromString(
        RadarVenueDetail.serializer(),
        edge.getRaw(
            "$VENUES_PATH/$id",
            mapOf("window" to window.wire),
            cacheTtlMillis = CACHE_TTL_MILLIS,
        ),
    )

    companion object {
        const val VENUES_PATH = "/api/flipdesk/radar/venues"

        /** Long enough to make a pan free, short enough that a day's scans land. */
        const val CACHE_TTL_MILLIS = 120_000L

        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * Whether a failure is the plan wall rather than a transport problem.
         *
         * The difference is a button: a Try-again on a plan wall only hits the
         * same wall, and offering it reads as the app being broken rather than
         * the plan being the limit. The upgrade dialog is already on screen by
         * the time this is asked ([EdgeApi] publishes the 402 gate).
         */
        fun isPlanGated(error: Throwable): Boolean =
            (error as? EdgeApiError)?.isUpgradePrompt == true

        /**
         * Whether the server refused to say anything about this venue.
         *
         * A venue below the k-floor and a venue that never existed return the
         * IDENTICAL 404, so this cannot and must not tell them apart. Callers
         * word it as "nothing we can say", never as "no such shop".
         */
        fun isWithheld(error: Throwable): Boolean = error is EdgeApiError.NotFound
    }
}
