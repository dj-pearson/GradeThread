package com.gradethread.app.radar

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * US-2492: the two shared Radar reads.
 *
 * What these cases protect is not "does JSON decode" - it is the three places a
 * client can quietly undo the server's privacy work: sending a viewport the
 * endpoint refuses, reading a k-floored silence as a zero, and telling a seller
 * that a shop "does not exist" when the only honest answer is that we were told
 * nothing.
 */
class RadarServiceTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun service() = RadarService(
        EdgeApi(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            client = OkHttpClient(),
            tokenProvider = { "tk_1" },
            tokenRefresher = { null },
            // The real notifier raises the upgrade dialog; a unit test only
            // needs the error the caller sees.
            onPlanGate = { },
            sleeper = { /* no real sleeping in tests */ },
            // US-2496: the response cache is keyed on the workspace owner and a
            // null owner means NO caching, fail-closed. Without one here the
            // "panning back is free" case below would exercise a cache that
            // never stored anything and pass for the wrong reason on the day
            // someone broke quantizing.
            cacheOwnerProvider = { "owner-1" },
        ),
    )

    private fun respond(code: Int, body: String) {
        server.enqueue(
            MockResponse().setResponseCode(code)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    private val emptyVenues =
        """{"window":"30d","brand":null,"k_floor":3,"venues":[]}"""

    @Test
    fun `the viewport goes to the endpoint in the shape it parses`() = runTest {
        respond(200, emptyVenues)
        val box = RadarScoring.quantize(
            RadarScoring.boundingBox(around = RadarPoint(40.7128, -74.0060)),
        )
        service().venues(box.param, RadarWindow.SEVEN_DAYS)

        val path = server.takeRequest().path.orEmpty()
        assertTrue(path.startsWith("/api/flipdesk/radar/venues?"))
        assertTrue(path.contains("window=7d"))
        // Four ordered numbers, exactly what parseBoundingBox splits on. A fifth
        // (a locale's decimal comma) is a 400 and a blank screen.
        val bbox = path.substringAfter("bbox=").substringBefore("&")
        assertEquals(4, bbox.split("%2C", ",").size)
    }

    @Test
    fun `no brand filter means no brand parameter`() = runTest {
        respond(200, emptyVenues)
        service().venues("1,2,3,4")
        assertFalse(server.takeRequest().path.orEmpty().contains("brand="))

        respond(200, emptyVenues)
        service().venues("1,2,3,4", brand = "nike")
        assertTrue(server.takeRequest().path.orEmpty().contains("brand=nike"))
    }

    @Test
    fun `every window name matches what the endpoint accepts`() {
        // A wire value invented here would be silently replaced by the server's
        // default, so all three chips would show the same list.
        assertEquals(listOf("7d", "30d", "90d"), RadarWindow.entries.map { it.wire })
        assertEquals(RadarWindow.THIRTY_DAYS, RadarWindow.DEFAULT)
    }

    @Test
    fun `a venue decodes with its aggregate, and an absent average stays absent`() = runTest {
        respond(
            200,
            """{"window":"30d","brand":null,"k_floor":3,"venues":[
               {"id":"v1","display_name":"Goodwill on 5th","chain":"goodwill",
                "lat":40.7,"lng":-74.0,"status":"active",
                "network":{"venue_id":"v1","window":"30d","brand":null,
                  "scan_count":42,"contributor_count":6,"avg_grade":null,
                  "buy_rate":0.25,"grade_mix":{"high":3,"mid":4,"low":1,"ungraded":34},
                  "activity_by_day":[1,2,3,4,5,6,7],
                  "last_activity_at":"2026-08-01T00:00:00.000Z","days_since_activity":2}}]}""",
        )
        val payload = service().venues("1,2,3,4")
        val venue = payload.venues.single()

        assertEquals(3, payload.kFloor)
        assertEquals("Goodwill on 5th", venue.displayName)
        assertEquals(42, venue.network.scanCount)
        // Null, not 0.0. Nothing here has been graded, and printing an average
        // of zero would report a shop full of rags.
        assertNull(venue.network.avgGrade)
        assertEquals(8, venue.network.gradeMix.graded)
    }

    @Test
    fun `a below-floor venue and an unknown one are the same 404`() = runTest {
        respond(404, """{"error":"Venue not found"}""")
        val first = runCatching { service().venueDetail("v-below-floor") }.exceptionOrNull()

        respond(404, """{"error":"Venue not found"}""")
        val second = runCatching { service().venueDetail("v-never-existed") }.exceptionOrNull()

        // Both classify identically. Telling them apart would answer "did anyone
        // scan here?", the exact question the k-anonymity floor refuses.
        assertTrue(RadarService.isWithheld(first!!))
        assertTrue(RadarService.isWithheld(second!!))
        assertEquals(first.javaClass, second.javaClass)
    }

    @Test
    fun `the shared layer being Pro reads as a gate, not as a failure`() = runTest {
        respond(
            402,
            """{"error":"FEATURE_LOCKED","feature":"compPulls","plan":"free","requiredPlan":"pro"}""",
        )
        val error = runCatching { service().venues("1,2,3,4") }.exceptionOrNull()

        // The difference is a button: a Try-again on a plan wall only hits the
        // same wall, and offering it reads as the app being broken.
        assertTrue(RadarService.isPlanGated(error!!))
        assertFalse(RadarService.isWithheld(error))
    }

    @Test
    fun `a repeated viewport is served from the cache instead of the network`() = runTest {
        respond(200, emptyVenues)
        val radar = service()
        radar.venues("1,2,3,4")
        radar.venues("1,2,3,4")

        // One request enqueued, one consumed: panning back and forth over the
        // same quantized box is free, which is why quantizing is worth doing.
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `the detail path names the venue and carries the window`() = runTest {
        respond(
            200,
            """{"window":"90d","k_floor":3,
               "venue":{"id":"v1","display_name":"Thrift","chain":null,
                 "lat":1.0,"lng":2.0,"status":"active"},
               "network":{"venue_id":"v1","scan_count":9,"contributor_count":4,
                 "grade_mix":{"high":0,"mid":0,"low":0,"ungraded":9}},
               "brands":[{"venue_id":"v1","brand":"nike","scan_count":5,
                 "contributor_count":3}]}""",
        )
        val detail = service().venueDetail("v1", RadarWindow.NINETY_DAYS)

        assertEquals(
            "/api/flipdesk/radar/venues/v1?window=90d",
            server.takeRequest().path,
        )
        assertEquals("Thrift", detail.venue.displayName)
        assertEquals("nike", detail.brands.single().brand)
        // Nothing graded is not a condition picture. The screen has to say so
        // rather than draw three empty bars.
        assertEquals(0, detail.network.gradeMix.graded)
    }
}
