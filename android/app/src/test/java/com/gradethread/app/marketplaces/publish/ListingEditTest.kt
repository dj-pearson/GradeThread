package com.gradethread.app.marketplaces.publish

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * US-2490: repricing, resubmitting and ending a live listing.
 *
 * Publishing from the phone used to be a one-way door. The cases worth pinning
 * are the two that decide whether a seller can trust these buttons: a reprice
 * must not re-assert anything else, and an eBay-authored listing must refuse
 * with eBay's own explanation rather than a generic failure.
 */
class ListingEditTest {

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

    private fun service() = EbayPublishService(
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
    fun `a reprice sends the price and nothing else`() = runTest {
        respond(200, """{"ok":true,"listing_id":"l1","price":34.5,"pushed":true}""")
        val outcome = service().setPrice("l1", 34.5)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/flipdesk/ebay/listings/l1/price", request.path)
        // The whole reason this is its own endpoint: a price drop must not
        // republish a half-finished draft edit sitting in the database.
        assertEquals("""{"price":34.5}""", request.body.readUtf8())
        assertEquals(PublishOutcome.Done, outcome)
    }

    @Test
    fun `a resubmit re-asserts photos and the eBay-owned fields`() = runTest {
        respond(200, """{"ok":true}""")
        service().revise("l1", photos = true, resyncEbayFields = true)

        val body = server.takeRequest().body.readUtf8()
        // resync_ebay_fields is what makes a specifics correction made on the
        // phone (US-2413) actually reach the live listing, instead of sitting
        // on the item waiting for a relist.
        assertTrue(body.contains("\"photos\":true"))
        assertTrue(body.contains("\"resync_ebay_fields\":true"))
        // Absent, not null: the server reads absence as "leave it alone", and
        // an explicit null title would be a title change to nothing.
        assertFalse(body.contains("\"title\""))
        assertFalse(body.contains("\"description\""))
    }

    @Test
    fun `an untouched flag is omitted entirely`() = runTest {
        respond(200, """{"ok":true}""")
        service().revise("l1", price = 20.0)

        val body = server.takeRequest().body.readUtf8()
        assertEquals("""{"listing_price":20.0}""", body)
    }

    @Test
    fun `ending uses DELETE on the listing itself`() = runTest {
        respond(200, """{"ok":true,"ended_on_ebay":true}""")
        val outcome = service().endListing("l1")

        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/flipdesk/ebay/listings/l1", request.path)
        assertEquals(PublishOutcome.Done, outcome)
    }

    @Test
    fun `an eBay-authored listing refuses with eBay's own explanation`() = runTest {
        // The 409 the server returns for a listing eBay created. Ending it here
        // would be overwritten on the next inbound sync, and nothing on the
        // device could work that out — so the sentence is shown as written.
        val sentence = "This listing was created on eBay, so eBay owns its lifecycle. " +
            "End it on eBay - ending it here would be overwritten on the next sync."
        respond(
            409,
            """{"error":"$sentence","locked_fields":["listing_status","is_active"]}""",
        )

        val outcome = service().endListing("l1")
        assertTrue("was $outcome", outcome is PublishOutcome.Failed)
        assertEquals(sentence, (outcome as PublishOutcome.Failed).message)
    }

    @Test
    fun `a plan wall is reported as a plan wall, not a failure`() = runTest {
        respond(
            402,
            """{"error":"CAP_REACHED","cap":"listings","used":50,"delta":1,"limit":50,
               "plan":"starter","requiredPlan":"pro"}""",
        )
        val outcome = service().setPrice("l1", 10.0)
        // A Try-again button on a plan wall does nothing but hit the same wall.
        assertTrue("was $outcome", outcome is PublishOutcome.PlanLimit)
    }

    @Test
    fun `the publish flow never reports a post-publish outcome as a success`() {
        // Done cannot reach the publish flow, but the flow's when is total on
        // purpose - a new outcome case must not leave the sheet spinning, and
        // must not claim a listing that was never created.
        val phase = PublishFlow.afterPush(PublishOutcome.Done)
        assertTrue("was $phase", phase is PublishPhase.Failed)
        assertEquals(PublishFlow.UNEXPECTED_DONE_MESSAGE, (phase as PublishPhase.Failed).message)
    }

    @Test
    fun `the three paths are built off the same listings base`() {
        // If these drift the buttons 404 and the seller is told eBay refused.
        assertEquals("/api/flipdesk/ebay/listings/l1/price", EbayPublishService.pricePath("l1"))
        assertEquals("/api/flipdesk/ebay/listings/l1/revise", EbayPublishService.revisePath("l1"))
        assertEquals("/api/flipdesk/ebay/listings/l1", EbayPublishService.endPath("l1"))
    }

    @Test
    fun `a typed price survives a comma decimal separator`() {
        // The sheet parses with the importer's parser rather than
        // toDoubleOrNull, because a seller types what their keyboard gives them.
        val parse = com.gradethread.app.importer.ImportValue::price
        assertEquals(34.5, parse("34,50")!!, 1e-9)
        assertEquals(34.5, parse("$34.50")!!, 1e-9)
        assertEquals(null, parse("  "))
    }

    private val json = Json { ignoreUnknownKeys = true }
}
