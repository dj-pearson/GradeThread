package com.gradethread.app.money

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
 * US-2491: the inventory equity card.
 *
 * The number is a LIQUIDATION estimate, and the two things worth pinning both
 * protect the seller from reading it as something better than it is: items the
 * server could not value are never folded in at zero, and a 404 means the
 * feature is off rather than that their inventory is missing.
 */
class EquityTest {

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

    private fun service() = EquityService(
        EdgeApi(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            client = OkHttpClient(),
            tokenProvider = { "tk_1" },
            tokenRefresher = { null },
            sleeper = { /* no real sleeping in tests */ },
        ),
    )

    private fun respond(code: Int, body: String) {
        server.enqueue(
            MockResponse().setResponseCode(code)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    @Test
    fun `the summary keeps the unvalued items and their reasons`() = runTest {
        respond(
            200,
            """{"currency":"USD","personalSellThroughDays":21.5,"aggregate":{
               "totalEquityCents":128000,"totalLowCents":96000,"totalHighCents":170000,
               "valuedCount":12,"unvaluedCount":5,
               "unvaluedByReason":{"no_grade":3,"no_comps":2},
               "byCategory":{"tops":{"cents":80000,"count":8},"bottoms":{"cents":48000,"count":4}},
               "byBrand":{},"byGradeBand":{}}}""",
        )
        val summary = service().summary()

        assertEquals("/api/flipdesk/equity", server.takeRequest().path)
        assertEquals(128000L, summary.aggregate.totalEquityCents)
        // Counted, not folded in at zero. A total that quietly treated five
        // ungraded items as worthless would be wrong in the one direction a
        // seller cannot detect.
        assertEquals(5, summary.aggregate.unvaluedCount)
        assertEquals(3, summary.aggregate.unvaluedByReason.noGrade)
        assertEquals(2, summary.aggregate.unvaluedByReason.noComps)
        assertEquals(21.5, summary.personalSellThroughDays!!, 1e-9)
    }

    @Test
    fun `the feature being switched off is not reported as missing inventory`() = runTest {
        // The server's 404 means "Inventory Equity is not enabled", not "we
        // couldn't find that" — which would send a seller looking for stock
        // they can see on the next screen.
        respond(404, """{"error":"Inventory Equity is not enabled."}""")
        val error = runCatching { service().summary() }.exceptionOrNull()
        assertEquals(EquityService.NOT_ENABLED, EquityService.message(error!!))
    }

    @Test
    fun `an account with no nightly snapshots yet has an empty trend, not a failure`() = runTest {
        respond(200, """{"currency":"USD","points":[]}""")
        val trend = service().trend()
        assertEquals("/api/flipdesk/equity/trend", server.takeRequest().path)
        assertTrue(trend.points.isEmpty())
        assertNull(Equity.movementCents(trend))
    }

    // ── the presentation rules ───────────────────────────────────────────

    private fun aggregate(total: Long, low: Long, high: Long, valued: Int = 3) =
        EquityAggregate(
            totalEquityCents = total,
            totalLowCents = low,
            totalHighCents = high,
            valuedCount = valued,
        )

    @Test
    fun `a range that collapses onto the total is not shown`() {
        // Which is what happens when every valued item had a single comp. A
        // "between $500 and $500" line is noise.
        assertFalse(Equity.hasRange(aggregate(50000, 50000, 50000)))
        assertTrue(Equity.hasRange(aggregate(50000, 40000, 60000)))
        // No valued items means no range worth printing either.
        assertFalse(Equity.hasRange(aggregate(0, 0, 0, valued = 0)))
    }

    @Test
    fun `buckets sort by value, not by count`() {
        // Ten cheap tees are not the thing to show above one designer coat.
        val buckets = mapOf(
            "tees" to EquityBucket(cents = 12000, count = 10),
            "outerwear" to EquityBucket(cents = 90000, count = 1),
            "bottoms" to EquityBucket(cents = 40000, count = 4),
        )
        assertEquals(
            listOf("outerwear", "bottoms", "tees"),
            Equity.topBuckets(buckets).map { it.first },
        )
    }

    @Test
    fun `bucket ties break on name so the order does not flicker`() {
        val buckets = mapOf(
            "zeta" to EquityBucket(cents = 100, count = 1),
            "alpha" to EquityBucket(cents = 100, count = 1),
        )
        assertEquals(listOf("alpha", "zeta"), Equity.topBuckets(buckets).map { it.first })
    }

    @Test
    fun `only the top few buckets are shown`() {
        val buckets = (1..9).associate { "c$it" to EquityBucket(cents = it * 100L, count = 1) }
        assertEquals(4, Equity.topBuckets(buckets).size)
        assertEquals("c9", Equity.topBuckets(buckets).first().first)
    }

    @Test
    fun `movement compares the last two snapshots and can be negative`() {
        val trend = EquityTrend(
            points = listOf(
                EquityPoint(snapshotDate = "2026-08-09", totalEquityCents = 100000),
                EquityPoint(snapshotDate = "2026-08-10", totalEquityCents = 120000),
                EquityPoint(snapshotDate = "2026-08-11", totalEquityCents = 90000),
            ),
        )
        assertEquals(-30000L, Equity.movementCents(trend))
    }

    @Test
    fun `one snapshot is not a movement`() {
        // A brand-new account has one point. Reporting it as a rise from zero
        // would invent a day of growth that never happened.
        val trend = EquityTrend(points = listOf(EquityPoint(totalEquityCents = 5000)))
        assertNull(Equity.movementCents(trend))
    }

    @Test
    fun `cents convert to dollars without drifting`() {
        assertEquals(1280.0, Equity.dollars(128000), 1e-9)
        assertEquals(0.01, Equity.dollars(1), 1e-9)
    }
}
