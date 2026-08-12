package com.gradethread.app.marketplaces.negotiation

import com.gradethread.app.inventory.ListingCopyService
import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * US-2494: the AI counter/reply draft.
 *
 * Two things are worth pinning. The body is snake_case and the guardrail comes
 * back in it, so a mistyped key would silently drop the suggested counter and
 * the warnings while still spending an AI action; and the quota statuses have
 * to speak the same words the listing-copy calls already do, because a second
 * mapping is a second thing to keep in step.
 */
class NegotiationDraftTest {

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

    private fun service() = NegotiationDraftService(
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
    fun `a counter draft sends the seller's own price for validation`() = runTest {
        respond(
            200,
            """{"message":"Thanks for the offer.","suggested_counter":42.5,
               "warnings":["Your counter is at or below the buyer's offer — just accept the offer instead."],
               "below_cost":false,"at_or_below_offer":true,"above_asking":false,
               "model":"m","log_id":"l1","actions_remaining":6}""",
        )
        val draft = service().draft(
            itemId = "item-1",
            mode = NegotiationDraftMode.COUNTER,
            offerPrice = 30.0,
            currency = "USD",
            buyerMessage = "  Would you take 30?  ",
            proposedCounter = 28.0,
        )

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/flipdesk/ai/negotiate", request.path)
        val body = request.body.readUtf8()
        // The FlipDesk item id, not eBay's listing id — the route reads
        // inventory_items and scopes it to the caller.
        assertTrue(body, body.contains(""""item_id":"item-1""""))
        assertTrue(body, body.contains(""""mode":"counter""""))
        assertTrue(body, body.contains(""""offer_price":30.0"""))
        assertTrue(body, body.contains(""""proposed_counter":28.0"""))
        assertTrue(body, body.contains(""""buyer_message":"Would you take 30?""""))

        assertEquals(42.5, draft.suggestedCounter!!, 0.001)
        assertEquals(1, draft.warnings.size)
        assertTrue(draft.atOrBelowOffer)
        assertEquals(6, draft.actionsRemaining)
    }

    @Test
    fun `a reply draft carries no price at all`() = runTest {
        respond(200, """{"message":"It fits a US 8.","warnings":[]}""")
        val draft = service().draft(
            itemId = "item-1",
            mode = NegotiationDraftMode.REPLY,
            buyerMessage = "What size is this?",
        )

        val body = server.takeRequest().body.readUtf8()
        assertTrue(body, body.contains(""""mode":"reply""""))
        assertTrue(body, !body.contains("offer_price"))
        assertTrue(body, !body.contains("proposed_counter"))
        // No offer means no counter to suggest, and the guardrail says so
        // rather than inventing one.
        assertNull(draft.suggestedCounter)
        assertEquals("It fits a US 8.", draft.message)
    }

    @Test
    fun `a used-up monthly allowance speaks the server's own sentence`() = runTest {
        val sentence = "You've used all 200 AI actions for this month. " +
            "Your allowance resets at the start of next month."
        respond(429, """{"error":"$sentence","actions_remaining":0}""")

        val error = runCatching {
            service().draft("item-1", NegotiationDraftMode.COUNTER)
        }.exceptionOrNull()
        assertTrue("was $error", error is EdgeApiError.AiActionsExhausted)
        // The same mapping the listing-copy calls use — one set of words for
        // one situation.
        assertEquals(
            ListingCopyService.message(error!!),
            NegotiationDraftService.message(error),
        )
        assertEquals(sentence, NegotiationDraftService.message(error))
    }

    @Test
    fun `an item the caller does not own reads as unsynced, not as missing`() = runTest {
        respond(404, """{"error":"Item not found"}""")
        val error = runCatching {
            service().draft("item-1", NegotiationDraftMode.REPLY)
        }.exceptionOrNull()
        assertEquals(ListingCopyService.ITEM_NOT_SYNCED, NegotiationDraftService.message(error!!))
    }

    @Test
    fun `the AI being down is not retried into a second spent action`() = runTest {
        // A 502 on a POST is never replayed by EdgeApi: the reserve may have
        // already happened server-side, and the route refunds it itself.
        respond(502, """{"error":"AI negotiation assist is temporarily unavailable."}""")
        runCatching { service().draft("item-1", NegotiationDraftMode.COUNTER) }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `an older edge build that omits the guardrail flags still decodes`() = runTest {
        respond(200, """{"message":"Thanks."}""")
        val draft = service().draft("item-1", NegotiationDraftMode.COUNTER)
        assertTrue(draft.warnings.isEmpty())
        assertTrue(!draft.belowCost && !draft.atOrBelowOffer && !draft.aboveAsking)
    }
}
