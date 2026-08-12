package com.gradethread.app.passport

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import io.github.jan.supabase.createSupabaseClient
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
 * US-2494: minting the buyer's one-time claim link.
 *
 * The raw token comes back exactly once — the server stores only its hash — so
 * a client that mangled the path, dropped a field or replayed the POST would
 * cost the seller a link they cannot ask for again.
 */
class PassportHandoffTest {

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

    private fun service() = PassportService(
        createSupabaseClient(supabaseUrl = "https://example.test", supabaseKey = "test-key") {},
        EdgeApi(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            client = OkHttpClient(),
            tokenProvider = { "tk_1" },
            tokenRefresher = { null },
            sleeper = { /* no real sleeping in tests */ },
        ),
    )

    @Test
    fun `the garment is named in the path, never in the body`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(201)
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """{"token":"tok_abc","claim_url":"https://gradethread.com/claim/tok_abc",
                       "expires_at":"2026-09-11T12:00:00Z"}""",
                ),
        )
        val handoff = service().mintClaimLink("g-1")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/passport/garments/g-1/claim-token", request.path)
        // Nothing about the mint is the client's to decide — no owner, no TTL.
        assertEquals("{}", request.body.readUtf8())
        assertEquals("https://gradethread.com/claim/tok_abc", handoff.claimUrl)
        assertEquals("2026-09-11T12:00:00Z", handoff.expiresAt)
    }

    @Test
    fun `a garment id is path-encoded rather than pasted in`() {
        assertEquals(
            "/api/passport/garments/a%2Fb/claim-token",
            PassportService.claimTokenPath("a/b"),
        )
    }

    @Test
    fun `someone else's garment is a plain not-found, not a retry`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(404)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Garment not found"}"""),
        )
        val error = runCatching { service().mintClaimLink("g-2") }.exceptionOrNull()
        assertTrue("was $error", error is EdgeApiError.NotFound)
        // One attempt. A POST that may have minted a token server-side must
        // never be replayed into a second one.
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `the expiry renders as a date the seller can read`() {
        val rendered = PassportFormat.longDate("2026-09-11T12:00:00Z")
        assertTrue(rendered, rendered.contains("2026"))
        assertFalse(rendered, rendered.contains("T12:00:00Z"))
    }
}
