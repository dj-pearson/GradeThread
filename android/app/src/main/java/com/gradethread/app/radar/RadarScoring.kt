package com.gradethread.app.radar

import java.util.Locale
import kotlin.math.asin
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * US-2492: the pure half of Sourcing Radar on Android.
 *
 * The THIRD copy of this arithmetic, after `src/lib/radar-map.ts` and
 * `ios/GradeThread/Prospect/RadarScoring.swift`, and the constants are pinned to
 * theirs on purpose: a shop that reads "Busiest near you" on the web must not
 * read "Quiet" in the app for the same numbers. Anything changed here has to
 * change in all three, or the same seller gets two answers about one shop
 * depending on which device is in their hand.
 *
 * No Android imports, no network, no Compose: every function is a function of
 * its arguments, so the ranking is unit-tested directly rather than through a
 * rendered list (`RadarScoringTest`).
 *
 * The map projection is deliberately absent. The phone surface is a ranked LIST,
 * not a canvas, so it needs the hotness, the freshness decay and the viewport
 * maths, and none of the Web Mercator arithmetic. Nothing here draws a tile map
 * either: tile URLs ARE the viewport, so panning one would stream the seller's
 * neighbourhood to a third party, which is the exact disclosure the schema
 * underneath was built to withhold.
 */

/**
 * A place on the ranked list: a venue's cell centre, or a linked store's.
 *
 * Deliberately NOT the seller's own position type. A fix is collected under a
 * runtime permission and held just long enough to build a box; a point is a
 * published coordinate the server already serves to everyone.
 */
data class RadarPoint(val lat: Double, val lng: Double)

/** The rectangle a `bbox=` query asks about. */
data class RadarBoundingBox(
    val minLat: Double,
    val minLng: Double,
    val maxLat: Double,
    val maxLng: Double,
) {
    /**
     * `minLat,minLng,maxLat,maxLng`, rounded - the exact shape
     * `parseBoundingBox` in `routes/flipdesk-radar.ts` parses.
     *
     * Formatted against [Locale.ROOT] rather than the device locale, because a
     * seller in Germany would otherwise send `52,5200` and the endpoint would
     * read five numbers where it wanted four.
     */
    val param: String
        get() = listOf(minLat, minLng, maxLat, maxLng)
            .joinToString(",") { String.format(Locale.ROOT, "%.4f", it) }

    fun contains(point: RadarPoint): Boolean =
        point.lat >= minLat && point.lat <= maxLat &&
            point.lng >= minLng && point.lng <= maxLng
}

/**
 * How much a brand counts toward hotness, for one reseller.
 *
 * Android does not compute these yet - see [RadarScoring.weightedActivity] for
 * what an empty list means and why the parameter is still here.
 */
data class RadarBrandWeight(val brand: String, val weight: Double)

/** The inputs the hotness score reads, folded from the venue total. */
data class RadarVenueActivity(
    val allScans: Int = 0,
    /**
     * Per weighted brand key. A brand missing here lands as a zero, which is the
     * correct reading: not "no Nike here" but "nothing we can say about Nike
     * here".
     */
    val brandScans: Map<String, Int> = emptyMap(),
    val daysSince: Int? = null,
)

enum class RadarHotnessLevel { QUIET, WARM, HOT, PEAK }

/**
 * How recently somebody scanned, as a DECISION rather than a sentence.
 *
 * The web and iOS copies return English here. Android cannot: the label is user
 * copy and has to reach the screen through `stringResource`, so the pure layer
 * picks the band and a composable resolves it (US-2368's pattern).
 */
enum class RadarFreshness { UNKNOWN, TODAY, YESTERDAY, DAYS_AGO, LAST_WEEK, THIS_MONTH, OLDER }

/**
 * One row of the nearby list: a venue, one of the reseller's own stores, or both
 * at once.
 *
 * "Both at once" is the point. "Have I done well here before" and "are strangers
 * busy here" are questions about the same shop, and answering them in two
 * separate lists would make the reader do the join.
 */
data class RadarNearbyRow(
    val id: String,
    /** Null for one of the reseller's own sources with no place on the map. */
    val venueId: String? = null,
    val name: String,
    val chain: String? = null,
    val distanceKm: Double? = null,
    /** Null when the network has nothing servable here. */
    val network: RadarNetworkStats? = null,
    /** The reseller's own history at this shop, when they have any. */
    val personal: MyStore? = null,
    /**
     * Null for a row the network cannot speak about. NOT zero: zero would claim
     * we looked and found it quiet.
     */
    val score: Double? = null,
) {
    val level: RadarHotnessLevel? get() = score?.let(RadarScoring::hotnessLevel)
}

object RadarScoring {

    // -- Viewport --------

    /**
     * Mirrors `MAX_BBOX_DEGREES` in `routes/flipdesk-radar.ts`. A larger ask is a
     * scrape, not a map, and the endpoint answers it with a 400.
     */
    const val MAX_BOUNDING_BOX_DEGREES = 5.0

    /**
     * How far "nearby" reaches by default. Wide enough to cover the shops on one
     * sourcing run, narrow enough that the answer is about where the seller is.
     */
    const val DEFAULT_RADIUS_KM = 25.0

    /** Padding around the seller's own stores on the cold-start box. */
    const val DEFAULT_PADDING_KM = 8.0

    /** Degrees of latitude per kilometre, near enough for a viewport. */
    private const val KM_PER_LAT_DEGREE = 111.0

    private const val EARTH_RADIUS_KM = 6371.0

    fun clamp(value: Double, lower: Double, upper: Double): Double =
        min(upper, max(lower, value))

    /**
     * A box around a point. [radiusKm] is a half-width, so the box is roughly
     * twice that on a side.
     */
    fun boundingBox(
        around: RadarPoint,
        radiusKm: Double = DEFAULT_RADIUS_KM,
    ): RadarBoundingBox {
        val latDelta = radiusKm / KM_PER_LAT_DEGREE
        // Longitude degrees shrink toward the poles; without the cosine a box at
        // 60 degrees north would be twice as wide on the ground as it is tall.
        val cosLat = max(0.05, cos(Math.toRadians(around.lat)))
        val lngDelta = radiusKm / (KM_PER_LAT_DEGREE * cosLat)
        return clampSpan(
            RadarBoundingBox(
                minLat = clamp(around.lat - latDelta, -90.0, 90.0),
                minLng = clamp(around.lng - lngDelta, -180.0, 180.0),
                maxLat = clamp(around.lat + latDelta, -90.0, 90.0),
                maxLng = clamp(around.lng + lngDelta, -180.0, 180.0),
            ),
        )
    }

    /**
     * A box covering every point, or null when there are none.
     *
     * This is the cold-start path and the reason Radar opens with no permission
     * prompt: a reseller's own linked stores are places we already know, so the
     * first list is centred on those without asking Android anything.
     */
    fun boundingBox(
        covering: List<RadarPoint>,
        paddingKm: Double = DEFAULT_PADDING_KM,
    ): RadarBoundingBox? {
        val first = covering.firstOrNull() ?: return null
        var minLat = first.lat
        var maxLat = first.lat
        var minLng = first.lng
        var maxLng = first.lng
        for (point in covering.drop(1)) {
            minLat = min(minLat, point.lat)
            maxLat = max(maxLat, point.lat)
            minLng = min(minLng, point.lng)
            maxLng = max(maxLng, point.lng)
        }
        val centreLat = (minLat + maxLat) / 2
        val padLat = paddingKm / KM_PER_LAT_DEGREE
        val padLng = paddingKm / (KM_PER_LAT_DEGREE * max(0.05, cos(Math.toRadians(centreLat))))
        return clampSpan(
            RadarBoundingBox(
                minLat = clamp(minLat - padLat, -90.0, 90.0),
                minLng = clamp(minLng - padLng, -180.0, 180.0),
                maxLat = clamp(maxLat + padLat, -90.0, 90.0),
                maxLng = clamp(maxLng + padLng, -180.0, 180.0),
            ),
        )
    }

    /**
     * Shrink a box around its own centre until neither side exceeds the limit the
     * endpoint enforces, so a wide ask returns less rather than 400ing.
     */
    fun clampSpan(
        box: RadarBoundingBox,
        maxDegrees: Double = MAX_BOUNDING_BOX_DEGREES,
    ): RadarBoundingBox {
        val latSpan = min(box.maxLat - box.minLat, maxDegrees)
        val lngSpan = min(box.maxLng - box.minLng, maxDegrees)
        val midLat = (box.minLat + box.maxLat) / 2
        val midLng = (box.minLng + box.maxLng) / 2
        return RadarBoundingBox(
            minLat = clamp(midLat - latSpan / 2, -90.0, 90.0),
            minLng = clamp(midLng - lngSpan / 2, -180.0, 180.0),
            maxLat = clamp(midLat + latSpan / 2, -90.0, 90.0),
            maxLng = clamp(midLng + lngSpan / 2, -180.0, 180.0),
        )
    }

    /** The grid a viewport is snapped to before it leaves the device. */
    const val QUANTIZE_STEP = 0.05

    /**
     * Snap a box onto a coarse grid.
     *
     * Two jobs, and the second is the one that matters: it keeps a small movement
     * re-using the same query, AND it stops the sequence of requests from being a
     * fine-grained trace of where the seller is standing. The whole point of this
     * feature's schema is that no precise position is stored; sending one four
     * decimal places at a time in a query string would give it away by another
     * route.
     */
    fun quantize(box: RadarBoundingBox, step: Double = QUANTIZE_STEP): RadarBoundingBox {
        if (step <= 0) return box
        return RadarBoundingBox(
            minLat = floor(box.minLat / step) * step,
            minLng = floor(box.minLng / step) * step,
            maxLat = ceil(box.maxLat / step) * step,
            maxLng = ceil(box.maxLng / step) * step,
        )
    }

    /**
     * Great-circle distance in kilometres. Used only to LABEL rows and to break
     * ties; the ranking itself is activity, not proximity.
     */
    fun distanceKm(a: RadarPoint, b: RadarPoint): Double {
        val dLat = Math.toRadians(b.lat - a.lat)
        val dLng = Math.toRadians(b.lng - a.lng)
        val lat1 = Math.toRadians(a.lat)
        val lat2 = Math.toRadians(b.lat)
        val h = sin(dLat / 2) * sin(dLat / 2) +
            sin(dLng / 2) * sin(dLng / 2) * cos(lat1) * cos(lat2)
        return 2 * EARTH_RADIUS_KM * asin(min(1.0, sqrt(h)))
    }

    // -- Hotness --------

    /**
     * How much a brand-matched scan is worth relative to an unmatched one.
     *
     * Weighting, not filtering. A shop nobody has scanned your brands at can
     * still be the busiest place in town, and dropping it would make the list lie
     * about where the supply is.
     */
    const val BRAND_BOOST = 2.0

    /**
     * Freshness decay. Stepped rather than continuous, because the underlying
     * number is a whole day and a smooth curve would imply a resolution the data
     * does not have. An unknown last-scan is treated as the OLDEST bucket: an
     * unknown is not a recommendation.
     */
    fun freshnessFactor(daysSince: Int?): Double = when {
        daysSince == null -> 0.3
        daysSince <= 3 -> 1.0
        daysSince <= 7 -> 0.75
        daysSince <= 21 -> 0.5
        else -> 0.3
    }

    /** Which sentence the screen should read out. Same bands as web and iOS. */
    fun freshness(daysSince: Int?): RadarFreshness = when {
        daysSince == null -> RadarFreshness.UNKNOWN
        daysSince <= 0 -> RadarFreshness.TODAY
        daysSince == 1 -> RadarFreshness.YESTERDAY
        daysSince <= 7 -> RadarFreshness.DAYS_AGO
        daysSince <= 14 -> RadarFreshness.LAST_WEEK
        daysSince <= 31 -> RadarFreshness.THIS_MONTH
        else -> RadarFreshness.OLDER
    }

    /**
     * Unnormalized weight of one venue's activity, for this reseller.
     *
     * [weights] is empty on Android today, which is the same formula with a zero
     * term: the per-brand refinement costs one extra `/venues` request per brand,
     * and the list is correct without it. The parameter stays so adding those
     * requests is a change to the CALLER and not to the arithmetic the three
     * platforms have to agree on.
     */
    fun weightedActivity(
        activity: RadarVenueActivity,
        weights: List<RadarBrandWeight> = emptyList(),
    ): Double {
        var score = max(0, activity.allScans).toDouble()
        for (weight in weights) {
            val scans = activity.brandScans[weight.brand] ?: 0
            score += max(0, scans) * weight.weight * BRAND_BOOST
        }
        return score * freshnessFactor(activity.daysSince)
    }

    /**
     * 0..1 hotness, relative to the hottest venue currently listed.
     *
     * Relative on purpose: "hot" means "hotter than the rest of what you can
     * see", which is the comparison a reseller planning a route actually makes.
     * An absolute scale would paint a whole quiet region cold and say nothing
     * about which of its shops to try.
     */
    fun hotnessScore(
        activity: RadarVenueActivity,
        weights: List<RadarBrandWeight> = emptyList(),
        peak: Double,
    ): Double {
        if (peak <= 0) return 0.0
        return clamp(weightedActivity(activity, weights) / peak, 0.0, 1.0)
    }

    fun hotnessLevel(score: Double): RadarHotnessLevel = when {
        score >= 0.75 -> RadarHotnessLevel.PEAK
        score >= 0.45 -> RadarHotnessLevel.HOT
        score >= 0.2 -> RadarHotnessLevel.WARM
        else -> RadarHotnessLevel.QUIET
    }

    // -- Ranking --------

    /**
     * Order the list.
     *
     * Hotness first, so the answer to "is this shop worth walking into?" is at
     * the top; distance only breaks ties. Rows the network cannot speak about -
     * the reseller's own stores below the k-floor, or that nobody else has been
     * to - sort AFTER the scored ones but are never dropped: those are the places
     * they actually go, and a list that hid them would be less useful than the
     * one they had before Radar existed.
     */
    fun rank(rows: List<RadarNearbyRow>): List<RadarNearbyRow> = rows.sortedWith(ranking)

    private val ranking = Comparator<RadarNearbyRow> { lhs, rhs ->
        val byScore = compareDescendingNullsLast(lhs.score, rhs.score)
        if (byScore != 0) return@Comparator byScore
        val byDistance = compareAscendingNullsLast(lhs.distanceKm, rhs.distanceKm)
        if (byDistance != 0) return@Comparator byDistance
        lhs.name.compareTo(rhs.name, ignoreCase = true)
    }

    private fun compareDescendingNullsLast(lhs: Double?, rhs: Double?): Int = when {
        lhs != null && rhs != null -> rhs.compareTo(lhs)
        lhs != null -> -1
        rhs != null -> 1
        else -> 0
    }

    private fun compareAscendingNullsLast(lhs: Double?, rhs: Double?): Int = when {
        lhs != null && rhs != null -> lhs.compareTo(rhs)
        lhs != null -> -1
        rhs != null -> 1
        else -> 0
    }

    // -- Rows --------

    /**
     * Fold the two layers into one ranked list.
     *
     * Pure so the blend is testable without a view model: served venues first,
     * then the reseller's own linked stores the network had nothing to say about,
     * which keep a null score rather than a zero one.
     */
    fun rows(
        venues: List<RadarVenue>,
        personal: List<MyStore>,
        centre: RadarPoint? = null,
        area: RadarBoundingBox? = null,
        weights: List<RadarBrandWeight> = emptyList(),
    ): List<RadarNearbyRow> {
        val mineByVenue = personal.mapNotNull { store -> store.venueId?.let { it to store } }
            .toMap()
        val activities = venues.associate { venue ->
            venue.id to RadarVenueActivity(
                allScans = venue.network.scanCount,
                daysSince = venue.network.daysSinceActivity,
            )
        }
        val peak = activities.values.maxOfOrNull { weightedActivity(it, weights) } ?: 0.0

        val out = venues.map { venue ->
            val activity = activities[venue.id] ?: RadarVenueActivity()
            RadarNearbyRow(
                id = venue.id,
                venueId = venue.id,
                name = venue.displayName,
                chain = venue.chain,
                distanceKm = centre?.let { distanceKm(it, RadarPoint(venue.lat, venue.lng)) },
                network = venue.network,
                personal = mineByVenue[venue.id],
                score = hotnessScore(activity, weights, peak),
            )
        }.toMutableList()

        // Whatever is left is a shop of theirs the network has nothing to say
        // about - below the floor, or nobody else has been. These are the places
        // they actually go, so they stay on the list.
        val served = venues.map { it.id }.toSet()
        for (store in personal) {
            val venueId = store.venueId ?: continue
            if (venueId in served) continue
            val point = store.point ?: continue
            if (area != null && !area.contains(point)) continue
            out.add(
                RadarNearbyRow(
                    id = venueId,
                    venueId = venueId,
                    name = store.name,
                    chain = store.chain,
                    distanceKm = centre?.let { distanceKm(it, point) },
                    network = null,
                    personal = store,
                    score = null,
                ),
            )
        }
        return rank(out)
    }
}

/**
 * A distance, in the units the seller's own locale uses.
 *
 * The number and the unit are decided here rather than in the view so the choice
 * is testable and so the view is left picking between two string resources. Most
 * GradeThread sellers source in the US, where "18 km away" is a number nobody
 * converts in their head while deciding whether to drive.
 */
data class RadarDistance(val value: Double, val imperial: Boolean)

object RadarFormat {

    private const val KM_PER_MILE = 1.609344

    /** Where road distances are posted in miles. */
    private val IMPERIAL_COUNTRIES = setOf("US", "GB", "LR", "MM")

    fun distance(km: Double, locale: Locale = Locale.getDefault()): RadarDistance {
        val imperial = locale.country.uppercase(Locale.ROOT) in IMPERIAL_COUNTRIES
        return RadarDistance(if (imperial) km / KM_PER_MILE else km, imperial)
    }

    /** One decimal place close by, none further out: 0.1 of a mile at 40 miles
     *  is a precision the cell centre underneath does not have. */
    fun number(value: Double, locale: Locale = Locale.getDefault()): String =
        if (value < 10) String.format(locale, "%.1f", value) else String.format(locale, "%.0f", value)
}

/** Placeable on the nearby list: the registry knows where this shop is. */
val MyStore.point: RadarPoint?
    get() {
        val lat = this.lat ?: return null
        val lng = this.lng ?: return null
        return RadarPoint(lat, lng)
    }
