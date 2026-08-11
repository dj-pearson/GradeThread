package com.gradethread.app.inventory

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
 * US-2411: AI listing copy and specifics extraction.
 *
 * Two things are worth pinning. Neither route writes to the item, so the merge
 * rules here decide what a seller keeps; and the AI-actions 429 is not a rate
 * limit, so telling them to slow down would send them back to press the same
 * button on an allowance that resets next month.
 */
class ListingAiTest {

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

    private fun service() = ListingCopyService(
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

    // ── listing copy ─────────────────────────────────────────────────────

    @Test
    fun `listing copy sends only the item id, because the server holds the photos`() = runTest {
        respond(
            200,
            """{"title":"Wool coat","description":"Navy wool.","model":"m","log_id":"l1","actions_remaining":7}""",
        )
        val copy = service().listingCopy("item-1")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/flipdesk/ai/listing-copy", request.path)
        assertEquals("""{"item_id":"item-1"}""", request.body.readUtf8())
        assertEquals("Wool coat", copy.title)
        assertEquals(7, copy.actionsRemaining)
        assertTrue(copy.isUsable)
    }

    @Test
    fun `an empty answer is not usable, so it can never overwrite real copy`() {
        assertFalse(ListingCopy(title = "", description = "").isUsable)
        assertTrue(ListingCopy(title = "", description = "Just a description").isUsable)
    }

    @Test
    fun `an item that has not synced is named as such, not reported as missing`() = runTest {
        // The server says "Item not found", which reads as data loss. The item
        // is on the phone; it is the photos the model needs that have not
        // uploaded, and the seller's move is to wait, not to panic.
        respond(404, """{"error":"Item not found"}""")
        val error = runCatching { service().listingCopy("item-1") }.exceptionOrNull()
        assertTrue(error is EdgeApiError.NotFound)
        assertEquals(ListingCopyService.ITEM_NOT_SYNCED, ListingCopyService.message(error!!))
    }

    @Test
    fun `a used-up monthly allowance is not a rate limit`() = runTest {
        val sentence = "You've used all 200 AI actions for this month. " +
            "Your allowance resets at the start of next month."
        respond(429, """{"error":"$sentence","actions_remaining":0}""")

        val error = runCatching { service().listingCopy("item-1") }.exceptionOrNull()
        // RateLimited would say "you're going a little too fast, try again in
        // a moment" — which sends them straight back to the same button.
        assertTrue("was $error", error is EdgeApiError.AiActionsExhausted)
        assertEquals(0, (error as EdgeApiError.AiActionsExhausted).actionsRemaining)
        assertEquals(sentence, ListingCopyService.message(error))
        assertTrue(error.isUpgradePrompt)
    }

    @Test
    fun `a real rate limit is still a rate limit, and is still retried`() = runTest {
        // No actions_remaining in the body — this one IS worth waiting out, so
        // EdgeApi retries it. Three responses because it makes three attempts.
        repeat(3) { respond(429, """{"error":"Too many requests. Please try again later."}""") }
        val error = runCatching { service().listingCopy("item-1") }.exceptionOrNull()
        assertTrue("was $error", error is EdgeApiError.RateLimited)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `an exhausted allowance is not retried`() = runTest {
        // Retrying a monthly allowance spends nothing and fixes nothing; the
        // one enqueued response is the whole test.
        respond(429, """{"error":"You've used all your AI actions.","actions_remaining":0}""")
        runCatching { service().listingCopy("item-1") }
        assertEquals(1, server.requestCount)
    }

    // ── aspect extraction ────────────────────────────────────────────────

    @Test
    fun `extraction sends the category and what is already filled`() = runTest {
        respond(
            200,
            """{"category_id":"11554","suggestions":{"Sleeve Length":{"values":["Long Sleeve"],
               "confidence":0.9,"source":"photo"}},"model":"m","log_id":"l","actions_remaining":6,
               "aspects_considered":27,"aspects_available":134}""",
        )
        val result = service().extractAspects(
            itemId = "item-1",
            categoryId = "11554",
            knownAspects = mapOf("Brand" to listOf("Nike")),
        )

        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"item_id\":\"item-1\""))
        assertTrue(body.contains("\"category_id\":\"11554\""))
        // Sent so the model does not spend its answer re-proposing a value the
        // seller already typed.
        assertTrue(body.contains("\"known_aspects\":{\"Brand\":[\"Nike\"]}"))
        assertEquals(listOf("Long Sleeve"), result.suggestions.getValue("Sleeve Length").values)
        assertEquals(27, result.aspectsConsidered)
    }

    @Test
    fun `the free early return decodes, model and counts absent`() = runTest {
        // The category exposes no fillable specifics. No AI action is spent,
        // and the response drops three keys — a real answer, not a failure.
        respond(200, """{"category_id":"1","suggestions":{},"model":null,"log_id":null,"actions_remaining":9}""")
        val result = service().extractAspects("item-1")
        assertTrue(result.suggestions.isEmpty())
        assertEquals(null, result.model)
        assertEquals(0, result.aspectsConsidered)
    }

    @Test
    fun `known aspects and a blank category are left off the body entirely`() = runTest {
        respond(200, """{"category_id":"1","suggestions":{},"actions_remaining":9}""")
        service().extractAspects("item-1", categoryId = "  ", knownAspects = emptyMap())
        val body = server.takeRequest().body.readUtf8()
        assertEquals("""{"item_id":"item-1"}""", body)
    }

    // ── the merge: what a seller keeps ───────────────────────────────────

    @Test
    fun `a value the seller typed is never overwritten`() {
        val (aspects, sources, filled) = AspectSync.fillFromAi(
            aspects = mapOf("Brand" to listOf("Nike")),
            sources = mapOf("Brand" to AspectSync.Provenance.MANUAL),
            suggestions = mapOf("Brand" to listOf("Adidas")),
        )
        assertEquals(listOf("Nike"), aspects.getValue("Brand"))
        assertEquals(AspectSync.Provenance.MANUAL, sources.getValue("Brand"))
        assertEquals(0, filled)
    }

    @Test
    fun `an empty specific is filled and marked as the AI's`() {
        val (aspects, sources, filled) = AspectSync.fillFromAi(
            aspects = emptyMap(),
            sources = emptyMap(),
            suggestions = mapOf("Sleeve Length" to listOf("Long Sleeve")),
        )
        assertEquals(listOf("Long Sleeve"), aspects.getValue("Sleeve Length"))
        assertEquals(AspectSync.Provenance.AI_EXTRACTED, sources.getValue("Sleeve Length"))
        assertEquals(1, filled)
    }

    @Test
    fun `a previous AI fill can be replaced, because it was never anyone's opinion`() {
        val (aspects, _, filled) = AspectSync.fillFromAi(
            aspects = mapOf("Color" to listOf("Blue")),
            sources = mapOf("Color" to AspectSync.Provenance.AI_EXTRACTED),
            suggestions = mapOf("Color" to listOf("Navy")),
        )
        assertEquals(listOf("Navy"), aspects.getValue("Color"))
        assertEquals(1, filled)
    }

    @Test
    fun `an inventory-derived value is left alone`() {
        // It came from the item's own Brand column. The model does not get to
        // contradict a field the seller can see two sections up.
        val (aspects, _, filled) = AspectSync.fillFromAi(
            aspects = mapOf("Brand" to listOf("Nike")),
            sources = mapOf("Brand" to AspectSync.Provenance.INVENTORY_DERIVED),
            suggestions = mapOf("Brand" to listOf("Adidas")),
        )
        assertEquals(listOf("Nike"), aspects.getValue("Brand"))
        assertEquals(0, filled)
    }

    @Test
    fun `a suggestion that changes nothing is not counted as filled`() {
        // Otherwise the screen claims work it did not do, and a seller who
        // reran the pass would be told it added specifics twice.
        val (_, _, filled) = AspectSync.fillFromAi(
            aspects = mapOf("Color" to listOf("Navy")),
            sources = mapOf("Color" to AspectSync.Provenance.AI_EXTRACTED),
            suggestions = mapOf("Color" to listOf("Navy")),
        )
        assertEquals(0, filled)
    }

    @Test
    fun `blank suggested values are dropped rather than written as empty`() {
        val (aspects, _, filled) = AspectSync.fillFromAi(
            aspects = emptyMap(),
            sources = emptyMap(),
            suggestions = mapOf("Fit" to listOf("  ", ""), "Style" to listOf(" Bomber ")),
        )
        assertFalse(aspects.containsKey("Fit"))
        assertEquals(listOf("Bomber"), aspects.getValue("Style"))
        assertEquals(1, filled)
    }
}
