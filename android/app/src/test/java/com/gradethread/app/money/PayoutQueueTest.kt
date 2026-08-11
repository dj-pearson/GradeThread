package com.gradethread.app.money

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.coroutines.test.runTest
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
 * US-2489: the server payout matcher and its review queue.
 *
 * The queue is capped server-side, and the cap is the thing most worth pinning:
 * a seller with two hundred unmatched deposits who is shown fifty and told
 * nothing will believe they cleared the list. Everything else here is about
 * showing the server's own answer rather than a second opinion the seller
 * cannot check.
 */
class PayoutQueueTest {

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

    private fun service() = PayoutQueueService(
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
    fun `the queue carries the server's score and its reasons, unaltered`() = runTest {
        respond(
            200,
            """{"queue":[{"payout_import":{"id":"p1","payout_date":"2026-08-01","amount":42.5,
               "raw_payload":{"payoutid":"PAY-1"},"created_at":"2026-08-01T00:00:00Z"},
               "candidates":[{"sale_id":"s1","item_id":"i1","item_title":"Wool coat",
               "sale_date":"2026-07-30","sale_price":50.0,"payout_amount":42.5,
               "payout_reference":"PAY-1","score":0.93,
               "reasons":["payout id matches","amount within 1c"]}]}],
               "total":1,"showing":1,"has_more":false,"limit":50}""",
        )
        val queue = service().queue()

        assertEquals("/api/flipdesk/reconciliation/queue", server.takeRequest().path)
        val candidate = queue.queue.single().candidates.single()
        assertEquals(0.93, candidate.score, 1e-9)
        // Shown as written. Re-wording them would be a second opinion the
        // seller has nothing to check against.
        assertEquals(listOf("payout id matches", "amount within 1c"), candidate.reasons)
        assertEquals("PAY-1", queue.queue.single().payout.rawPayload["payoutid"].toString().trim('"'))
    }

    @Test
    fun `a truncated queue reports the real total`() = runTest {
        // The failure this prevents: fifty rows shown, two hundred waiting, and
        // a seller who believes the list is clear.
        respond(200, """{"queue":[],"total":214,"showing":50,"has_more":true,"limit":50}""")
        val queue = service().queue()
        assertTrue(queue.hasMore)
        assertEquals(214, queue.total)
        assertEquals(50, queue.showing)
    }

    @Test
    fun `an empty queue is not a truncated one`() = runTest {
        respond(200, """{"queue":[],"total":0,"showing":0,"has_more":false,"limit":50}""")
        val queue = service().queue()
        assertFalse(queue.hasMore)
        assertEquals(0, queue.total)
    }

    @Test
    fun `the sweep reports what it could NOT decide, not just what it did`() = runTest {
        respond(200, """{"auto_matched":7,"ambiguous":3,"no_candidates":2,"scanned":12}""")
        val sweep = service().run()

        assertEquals("POST", server.takeRequest().method)
        assertEquals(7, sweep.autoMatched)
        // The three the server refused to guess at are the whole point of the
        // review queue existing.
        assertEquals(3, sweep.ambiguous)
        assertEquals(2, sweep.noCandidates)
    }

    @Test
    fun `a match names both ids in the body`() = runTest {
        respond(200, """{"ok":true,"payout_import_id":"p1","sale_id":"s1"}""")
        service().match("p1", "s1")

        val request = server.takeRequest()
        assertEquals("/api/flipdesk/reconciliation/match", request.path)
        assertEquals(
            """{"payout_import_id":"p1","sale_id":"s1"}""",
            request.body.readUtf8(),
        )
    }

    @Test
    fun `an already-linked sale surfaces the server's un-match instruction`() = runTest {
        // A 409 here names the fix. Anything generic would leave the seller
        // re-tapping a button that cannot work.
        val sentence = "This sale or payout is already linked elsewhere. Un-match first."
        respond(409, """{"error":"$sentence","reason":"sale_already_linked"}""")

        val error = runCatching { service().match("p1", "s1") }.exceptionOrNull()
        assertTrue("was $error", error is EdgeApiError.BadRequest)
        assertEquals(sentence, PayoutQueueService.message(error!!))
    }

    @Test
    fun `dismiss puts the id in the path, not the body`() = runTest {
        respond(200, """{"ok":true,"payout_import_id":"p1"}""")
        service().dismiss("p1")
        assertEquals("/api/flipdesk/reconciliation/dismiss/p1", server.takeRequest().path)
    }

    @Test
    fun `a payout already dismissed is not an error`() = runTest {
        // The server answers `already` rather than 409, so a double tap or a
        // replayed request is a no-op the seller never sees.
        respond(200, """{"ok":true,"payout_import_id":"p1","already":true}""")
        service().dismiss("p1")
        assertEquals(1, server.requestCount)
    }
}
