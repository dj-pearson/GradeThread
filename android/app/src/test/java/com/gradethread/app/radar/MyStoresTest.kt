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
 * US-2495: the store history.
 *
 * Two things decide whether a seller can act on this screen: a shop that has
 * not sold anything yet must not be reported as a shop that failed, and a
 * partial read must not be presented as a complete comparison.
 */
class MyStoresTest {

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

    private fun service() = MyStoresService(
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
    fun `the sort goes to the server, in the server's own vocabulary`() = runTest {
        respond(200, """{"stores":[],"unplaced_visits":0,"unattributed_items":0,"sort":"roi","truncated":false}""")
        service().stores(StoreSort.ROI)

        val request = server.takeRequest()
        assertEquals("/api/flipdesk/radar/my-stores?sort=roi", request.path)
    }

    @Test
    fun `every sort name matches what the endpoint accepts`() {
        // A wire value invented here would be silently replaced by the server's
        // default, so the chips would all show the same list.
        assertEquals(
            listOf("profit", "roi", "items", "recent"),
            StoreSort.entries.map { it.wire },
        )
    }

    @Test
    fun `a shop with nothing sold yet has no return figure at all`() = runTest {
        respond(
            200,
            """{"stores":[{"key":"s1","source_id":"s1","name":"Goodwill on 5th",
               "items_sourced":6,"items_sold":0,"spend_cents":4200,"sold_spend_cents":0,
               "realized_profit_cents":0,"expected_profit_cents":18000,
               "roi_pct":428.6,"realized_roi_pct":null,"sell_through_pct":0.0,
               "top_brands":[]}],
               "unplaced_visits":0,"unattributed_items":0,"sort":"profit","truncated":false}""",
        )
        val store = service().stores().stores.single()

        // Null, not zero. Printing 0% would report a shop that has not had a
        // chance to sell as a shop that lost money.
        assertNull(store.realizedRoiPct)
        assertFalse(MyStoresRules.hasFigure(store.realizedRoiPct))
        assertTrue(MyStoresRules.hasFigure(store.roiPct))
        assertEquals(6, store.itemsSourced)
    }

    @Test
    fun `a truncated read is not reported as a complete comparison`() = runTest {
        respond(
            200,
            """{"stores":[],"unplaced_visits":3,"unattributed_items":11,
               "sort":"profit","truncated":true}""",
        )
        val stores = service().stores()
        assertFalse(MyStoresRules.isComplete(stores))
        // Counted, not folded into a fake "Unknown store" row — a shop nobody
        // can go back to is not a shop.
        assertEquals(3, stores.unplacedVisits)
        assertEquals(11, stores.unattributedItems)
    }

    @Test
    fun `the list is taken, not re-sorted`() {
        // The server caps the list, so sorting the page we happen to hold would
        // put the best of THIS page on top and call it the best shop.
        val stores = (1..30).map {
            MyStore(key = "k$it", name = "Shop $it", realizedProfitCents = it * 100L)
        }
        val top = MyStoresRules.top(stores)
        assertEquals(20, top.size)
        assertEquals("k1", top.first().key)
    }

    @Test
    fun `cents convert to dollars without drifting`() {
        assertEquals(42.0, MyStoresRules.dollars(4200), 1e-9)
        assertEquals(-1.5, MyStoresRules.dollars(-150), 1e-9)
    }
}
