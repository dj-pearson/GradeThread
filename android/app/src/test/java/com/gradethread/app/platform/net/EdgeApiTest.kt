package com.gradethread.app.platform.net

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * US-1306: behavioral tests over MockWebServer — the auth attach, forced 401
 * refresh, transient retry policy, plan-gate interception, and GET cache.
 */
class EdgeApiTest {

    private lateinit var server: MockWebServer
    private var token: String? = "tk_1"
    private var refreshResult: String? = null
    private var refreshes = 0
    private val gates = mutableListOf<PlanGateError>()
    private val warnings = mutableListOf<PlanWarning>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        token = "tk_1"
        refreshResult = null
        refreshes = 0
        gates.clear()
        warnings.clear()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun api(workspaceOwner: String? = null) = EdgeApi(
        baseUrl = server.url("/").toString().removeSuffix("/"),
        client = OkHttpClient(),
        tokenProvider = { token },
        tokenRefresher = {
            refreshes += 1
            refreshResult?.also { token = it }
        },
        workspaceOwnerProvider = { workspaceOwner },
        onPlanGate = { gates += it },
        onPlanWarning = { warnings += it },
        sleeper = { /* no real sleeping in tests */ },
    )

    // ── Auth attach ──

    @Test
    fun attachesBearerAndWorkspaceHeaders() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        api(workspaceOwner = "owner-1").getRaw("/api/ping")
        val recorded = server.takeRequest()
        assertEquals("Bearer tk_1", recorded.getHeader("Authorization"))
        assertEquals("owner-1", recorded.getHeader("X-Workspace-Owner"))
    }

    @Test
    fun signedOut_sendsNoAuthHeader() = runTest {
        token = null
        server.enqueue(MockResponse().setBody("{}"))
        api().getRaw("/api/public")
        assertNull(server.takeRequest().getHeader("Authorization"))
    }

    // ── Forced 401 refresh (US-1146) ──

    @Test
    fun serverRejectedToken_getsExactlyOneRefreshThenRetries() = runTest {
        refreshResult = "tk_fresh"
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))

        val body = api().getRaw("/api/needs-auth")
        assertEquals("""{"ok":true}""", body)
        assertEquals(1, refreshes)
        server.takeRequest()
        assertEquals("Bearer tk_fresh", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun refreshFailure_surfacesUnauthorizedWithoutLooping() = runTest {
        refreshResult = null
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        assertThrows(EdgeApiError.Unauthorized::class.java) {
            kotlinx.coroutines.runBlocking { api().getRaw("/api/needs-auth") }
        }
        assertEquals(1, refreshes)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun emailUnverified_skipsTheFutileRefresh() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(403).setBody("""{"code":"email_unverified"}"""),
        )
        assertThrows(EdgeApiError.EmailUnverified::class.java) {
            kotlinx.coroutines.runBlocking { api().getRaw("/api/gated") }
        }
        assertEquals(0, refreshes)
    }

    // ── Transient retry policy (US-638/1145/1164) ──

    @Test
    fun get_retries5xxUpToTwice() = runTest {
        server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
        server.enqueue(MockResponse().setBody("""{"ok":1}"""))
        assertEquals("""{"ok":1}""", api().getRaw("/api/flaky"))
        assertEquals(3, server.requestCount)
    }

    @Test
    fun post_neverRetries5xx() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("{}"))
        assertThrows(EdgeApiError.ServerError::class.java) {
            kotlinx.coroutines.runBlocking { api().postRaw("/api/create", "{}") }
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun post_doesRetry429_becauseItWasRejectedNotProcessed() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(429).setHeader("Retry-After", "1").setBody("{}"),
        )
        server.enqueue(MockResponse().setBody("""{"ok":1}"""))
        assertEquals("""{"ok":1}""", api().postRaw("/api/create", "{}"))
        assertEquals(2, server.requestCount)
    }

    @Test
    fun shouldRetry_decisionTable() {
        assertTrue(EdgeApi.shouldRetry(EdgeApiError.Network("x"), "POST"))
        assertTrue(EdgeApi.shouldRetry(EdgeApiError.RateLimited(), "POST"))
        assertTrue(EdgeApi.shouldRetry(EdgeApiError.ServerError(null), "GET"))
        assertEquals(false, EdgeApi.shouldRetry(EdgeApiError.ServerError(null), "POST"))
        assertEquals(false, EdgeApi.shouldRetry(EdgeApiError.BadRequest(null), "GET"))
        assertEquals(false, EdgeApi.shouldRetry(EdgeApiError.FeatureUnavailable(null), "GET"))
    }

    // ── Plan-gate interception (US-805) ──

    @Test
    fun planWarningHeader_emitsOnSuccessStatus() = runTest {
        server.enqueue(
            MockResponse().setBody("{}").setHeader(
                "X-Plan-Warning",
                "CAP_80;kind=aiActions;used=8;limit=10",
            ),
        )
        api().getRaw("/api/anything")
        assertEquals(1, warnings.size)
        assertEquals("aiActions", warnings[0].kind)
    }

    @Test
    fun planGate402_emitsAndThrowsBadRequest() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(402).setBody(
                """{"error":"CAP_REACHED","cap":"includedGrades","used":5,"limit":5,"requiredPlan":"starter"}""",
            ),
        )
        assertThrows(EdgeApiError.BadRequest::class.java) {
            kotlinx.coroutines.runBlocking { api().postRaw("/api/grade", "{}") }
        }
        assertEquals(1, gates.size)
        assertEquals("includedGrades", gates[0].cap)
    }

    // ── GET TTL cache (US-638/995) ──

    @Test
    fun cachedGet_servesFreshEntryWithoutASecondRequest() = runTest {
        server.enqueue(MockResponse().setBody("""{"n":1}"""))
        val a = api()
        assertEquals("""{"n":1}""", a.getRaw("/api/list", cacheTtlMillis = 60_000))
        assertEquals("""{"n":1}""", a.getRaw("/api/list", cacheTtlMillis = 60_000))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun ttlCache_expiresAndEvicts() {
        var now = 0L
        val cache = TtlCache(maxEntries = 2, maxBytes = 100, clock = { now })
        cache.put("a", "1", ttlMillis = 10)
        assertEquals("1", cache.get("a"))
        now = 11
        assertNull(cache.get("a"))

        // Entry-count LRU.
        cache.put("x", "1", 1000)
        cache.put("y", "2", 1000)
        cache.put("z", "3", 1000)
        assertNull(cache.get("x"))
        assertEquals("3", cache.get("z"))

        // Oversized blobs are never cached.
        cache.put("big", "b".repeat(200), 1000)
        assertNull(cache.get("big"))
    }
}
