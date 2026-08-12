package com.gradethread.app.radar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * US-2492: the ranking arithmetic, pinned to the two copies that already exist.
 *
 * Android is the THIRD implementation of `src/lib/radar-map.ts`, after iOS. The
 * numbers below are not preferences - they are the constants the web and iOS
 * copies use, and a seller who reads "Busiest near you" on one device must not
 * read "Quiet" on the other for the same shop.
 */
class RadarScoringTest {

    private fun venue(
        id: String,
        name: String = id,
        lat: Double = 0.0,
        lng: Double = 0.0,
        scans: Int = 0,
        contributors: Int = 3,
        daysSince: Int? = 0,
    ) = RadarVenue(
        id = id,
        displayName = name,
        lat = lat,
        lng = lng,
        network = RadarNetworkStats(
            venueId = id,
            scanCount = scans,
            contributorCount = contributors,
            daysSinceActivity = daysSince,
        ),
    )

    // -- Constants shared with web and iOS --------

    @Test
    fun `the viewport limit is the one the endpoint enforces`() {
        // MAX_BBOX_DEGREES in routes/flipdesk-radar.ts. A bigger ask is a 400,
        // so a mismatch here is a screen that loads nothing at wide zoom.
        assertEquals(5.0, RadarScoring.MAX_BOUNDING_BOX_DEGREES, 0.0)
        assertEquals(25.0, RadarScoring.DEFAULT_RADIUS_KM, 0.0)
        assertEquals(2.0, RadarScoring.BRAND_BOOST, 0.0)
        assertEquals(0.05, RadarScoring.QUANTIZE_STEP, 1e-12)
    }

    @Test
    fun `freshness decays in the same four steps as the web`() {
        assertEquals(1.0, RadarScoring.freshnessFactor(0), 1e-9)
        assertEquals(1.0, RadarScoring.freshnessFactor(3), 1e-9)
        assertEquals(0.75, RadarScoring.freshnessFactor(4), 1e-9)
        assertEquals(0.75, RadarScoring.freshnessFactor(7), 1e-9)
        assertEquals(0.5, RadarScoring.freshnessFactor(8), 1e-9)
        assertEquals(0.5, RadarScoring.freshnessFactor(21), 1e-9)
        assertEquals(0.3, RadarScoring.freshnessFactor(22), 1e-9)
        // An unknown is not a recommendation: it lands in the OLDEST bucket
        // rather than being treated as fresh.
        assertEquals(0.3, RadarScoring.freshnessFactor(null), 1e-9)
    }

    @Test
    fun `hotness bands are the web's thresholds`() {
        assertEquals(RadarHotnessLevel.PEAK, RadarScoring.hotnessLevel(0.75))
        assertEquals(RadarHotnessLevel.HOT, RadarScoring.hotnessLevel(0.74))
        assertEquals(RadarHotnessLevel.HOT, RadarScoring.hotnessLevel(0.45))
        assertEquals(RadarHotnessLevel.WARM, RadarScoring.hotnessLevel(0.44))
        assertEquals(RadarHotnessLevel.WARM, RadarScoring.hotnessLevel(0.2))
        assertEquals(RadarHotnessLevel.QUIET, RadarScoring.hotnessLevel(0.19))
    }

    @Test
    fun `a matched brand counts double, and never filters a shop out`() {
        val activity = RadarVenueActivity(
            allScans = 10,
            brandScans = mapOf("nike" to 4),
            daysSince = 0,
        )
        val weights = listOf(RadarBrandWeight("nike", 0.5))
        // 10 + (4 * 0.5 * 2) = 14, times a freshness factor of 1.
        assertEquals(14.0, RadarScoring.weightedActivity(activity, weights), 1e-9)
        // With no weights the same shop still scores its raw activity. Android
        // ships that way today, which is the same formula with a zero term.
        assertEquals(10.0, RadarScoring.weightedActivity(activity), 1e-9)
    }

    // -- Viewport --------

    @Test
    fun `a wide box is shrunk rather than sent as a 400`() {
        val wide = RadarBoundingBox(minLat = 0.0, minLng = 0.0, maxLat = 40.0, maxLng = 40.0)
        val clamped = RadarScoring.clampSpan(wide)
        assertEquals(5.0, clamped.maxLat - clamped.minLat, 1e-9)
        assertEquals(5.0, clamped.maxLng - clamped.minLng, 1e-9)
        // Shrunk around its own centre, so the seller keeps looking where they
        // were looking.
        assertEquals(20.0, (clamped.minLat + clamped.maxLat) / 2, 1e-9)
    }

    @Test
    fun `a box around a point stays inside the endpoint's limit`() {
        val box = RadarScoring.boundingBox(around = RadarPoint(51.5, -0.12))
        assertTrue(box.maxLat - box.minLat <= RadarScoring.MAX_BOUNDING_BOX_DEGREES + 1e-9)
        assertTrue(box.maxLng - box.minLng <= RadarScoring.MAX_BOUNDING_BOX_DEGREES + 1e-9)
        assertTrue(box.contains(RadarPoint(51.5, -0.12)))
    }

    @Test
    fun `the first box comes from the seller's own stores, with no location`() {
        // The cold-start path, and the reason Radar opens without a permission
        // prompt at all.
        val box = RadarScoring.boundingBox(
            covering = listOf(RadarPoint(40.70, -74.01), RadarPoint(40.75, -73.95)),
        )
        assertNotNull(box)
        assertTrue(box!!.contains(RadarPoint(40.70, -74.01)))
        assertTrue(box.contains(RadarPoint(40.75, -73.95)))
        // Nothing to centre on is null, not a box around the null island off
        // the coast of Africa.
        assertNull(RadarScoring.boundingBox(covering = emptyList()))
    }

    @Test
    fun `the viewport is quantized before it can become a trace`() {
        val box = RadarScoring.quantize(
            RadarBoundingBox(
                minLat = 40.712345,
                minLng = -74.006789,
                maxLat = 40.758901,
                maxLng = -73.951234,
            ),
        )
        // Snapped outward onto the 0.05 grid, so a few steps down the street
        // re-use the same query instead of drawing a path.
        assertEquals(40.70, box.minLat, 1e-9)
        assertEquals(40.80, box.maxLat, 1e-9)
        assertEquals(-74.05, box.minLng, 1e-9)
        assertEquals(-73.95, box.maxLng, 1e-9)
    }

    @Test
    fun `the bbox parameter is the shape the endpoint parses, in any locale`() {
        val previous = Locale.getDefault()
        try {
            // Germany writes 52,5200. Sent that way the endpoint reads five
            // numbers where it wanted four and 400s.
            Locale.setDefault(Locale.GERMANY)
            val param = RadarBoundingBox(1.5, 2.25, 3.0, 4.125).param
            assertEquals("1.5000,2.2500,3.0000,4.1250", param)
            assertEquals(4, param.split(",").size)
        } finally {
            Locale.setDefault(previous)
        }
    }

    @Test
    fun `distance is a great circle, not a straight line on a flat map`() {
        // London to Paris, about 344 km.
        val km = RadarScoring.distanceKm(RadarPoint(51.5074, -0.1278), RadarPoint(48.8566, 2.3522))
        assertEquals(344.0, km, 5.0)
        assertEquals(0.0, RadarScoring.distanceKm(RadarPoint(10.0, 10.0), RadarPoint(10.0, 10.0)), 1e-9)
    }

    // -- Ranking --------

    @Test
    fun `the busiest shop leads, and distance only breaks ties`() {
        val rows = RadarScoring.rows(
            venues = listOf(
                venue("far-busy", name = "Far and busy", lat = 1.0, scans = 100),
                venue("near-quiet", name = "Near and quiet", lat = 0.01, scans = 1),
            ),
            personal = emptyList(),
            centre = RadarPoint(0.0, 0.0),
        )
        assertEquals("far-busy", rows.first().id)
        assertEquals(RadarHotnessLevel.PEAK, rows.first().level)
    }

    @Test
    fun `a shop the network cannot speak about is kept, with no score`() {
        val mine = MyStore(
            key = "s1",
            venueId = "v-quiet",
            name = "My thrift",
            lat = 0.0,
            lng = 0.0,
            itemsSourced = 4,
        )
        val rows = RadarScoring.rows(
            venues = listOf(venue("v-busy", name = "Busy", scans = 50)),
            personal = listOf(mine),
        )
        val unscored = rows.single { it.id == "v-quiet" }
        // Null, not zero. Zero would claim we looked and found it quiet; the
        // k-floor means we were told nothing at all.
        assertNull(unscored.score)
        assertNull(unscored.network)
        assertNull(unscored.level)
        // Sorted after the scored one, but never dropped: it is where they
        // actually shop.
        assertEquals("v-busy", rows.first().id)
        assertEquals(2, rows.size)
    }

    @Test
    fun `a venue the seller already buys from carries both halves on one row`() {
        val mine = MyStore(key = "s1", venueId = "v1", name = "Mine", itemsSourced = 7)
        val rows = RadarScoring.rows(
            venues = listOf(venue("v1", name = "Shared name", scans = 20)),
            personal = listOf(mine),
        )
        val row = rows.single()
        // One row, not two lists the reader has to join.
        assertEquals("Shared name", row.name)
        assertEquals(7, row.personal?.itemsSourced)
        assertNotNull(row.network)
    }

    @Test
    fun `an unplaced store is never invented onto the map`() {
        val nowhere = MyStore(key = "s1", venueId = "v1", name = "No coordinates")
        val rows = RadarScoring.rows(venues = emptyList(), personal = listOf(nowhere))
        assertTrue(rows.isEmpty())
        assertNull(nowhere.point)
    }

    @Test
    fun `rows outside the area being shown are left out of it`() {
        val nearby = MyStore(key = "a", venueId = "v-in", name = "In", lat = 0.0, lng = 0.0)
        val distant = MyStore(key = "b", venueId = "v-out", name = "Out", lat = 40.0, lng = 40.0)
        val rows = RadarScoring.rows(
            venues = emptyList(),
            personal = listOf(nearby, distant),
            area = RadarBoundingBox(-1.0, -1.0, 1.0, 1.0),
        )
        assertEquals(listOf("v-in"), rows.map { it.id })
    }

    @Test
    fun `equally quiet shops fall back to name so the order does not jitter`() {
        val rows = RadarScoring.rows(
            venues = listOf(
                venue("b", name = "Bravo", scans = 5),
                venue("a", name = "Alpha", scans = 5),
            ),
            personal = emptyList(),
        )
        assertEquals(listOf("Alpha", "Bravo"), rows.map { it.name })
    }

    // -- Formatting --------

    @Test
    fun `distance is shown in the units the reader's country uses`() {
        val us = RadarFormat.distance(16.09344, Locale.US)
        assertTrue(us.imperial)
        assertEquals(10.0, us.value, 0.01)

        val fr = RadarFormat.distance(16.09344, Locale.FRANCE)
        assertFalse(fr.imperial)
        assertEquals(16.09, fr.value, 0.01)
    }

    @Test
    fun `precision drops past ten, where the cell centre has none to give`() {
        assertEquals("1.5", RadarFormat.number(1.5, Locale.US))
        assertEquals("42", RadarFormat.number(41.6, Locale.US))
    }

    @Test
    fun `the freshness band matches the sentence the web writes`() {
        assertEquals(RadarFreshness.UNKNOWN, RadarScoring.freshness(null))
        assertEquals(RadarFreshness.TODAY, RadarScoring.freshness(0))
        assertEquals(RadarFreshness.YESTERDAY, RadarScoring.freshness(1))
        assertEquals(RadarFreshness.DAYS_AGO, RadarScoring.freshness(7))
        assertEquals(RadarFreshness.LAST_WEEK, RadarScoring.freshness(8))
        assertEquals(RadarFreshness.THIS_MONTH, RadarScoring.freshness(31))
        assertEquals(RadarFreshness.OLDER, RadarScoring.freshness(32))
    }
}
