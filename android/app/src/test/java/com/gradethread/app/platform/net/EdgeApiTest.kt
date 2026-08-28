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

    private fun api(
        workspaceOwner: String? = null,
        // US-2496: the cache is off without an owner, so every test that
        // exercises caching has to say whose cache it is. Defaulted here to a
        // signed-in personal tenant, which is the ordinary case.
        cacheOwner: String? = "user-a",
    ) = EdgeApi(
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
        cacheOwnerProvider = { cacheOwner },
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

    /**
     * A 402 carrying a decodable plan-gate body is a PlanGated error, not a
     * generic bad request.
     *
     * This test asserted BadRequest until 2026-08-08, and it was right when it
     * was written (US-1306): 402 genuinely fell through the `in 400..499` arm.
     * US-1374 added the 402 branch that decodes the body into a typed
     * `PlanGated`, updated its own tests, and missed this older sibling — so the
     * assertion has been red on main ever since while the production behaviour
     * it describes was deliberately changed and is correct.
     *
     * The distinction is user-facing: `isUpgradePrompt` routes PlanGated to an
     * upgrade CTA, where a BadRequest would offer a retry button for a request
     * that will fail identically every time.
     */
    @Test
    fun planGate402_emitsAndThrowsPlanGated() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(402).setBody(
                """{"error":"CAP_REACHED","cap":"includedGrades","used":5,"limit":5,"requiredPlan":"starter"}""",
            ),
        )
        val thrown = assertThrows(EdgeApiError.PlanGated::class.java) {
            kotlinx.coroutines.runBlocking { api().postRaw("/api/grade", "{}") }
        }
        // Pin the upgrade routing, not just the type — the type alone would
        // still pass if PlanGated stopped counting as an upgrade prompt.
        assertEquals("includedGrades", thrown.gate.cap)
        assertTrue(thrown.isUpgradePrompt)
        // The emit half: the shell's upgrade dialog collects this flow, and it
        // is a separate mechanism from the throw. Both have to happen.
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

    /**
     * US-2496: the same path, the same query, a different tenant - a different
     * answer. `GET /api/flipdesk/photo-profiles` is served per
     * `workspaceOwnerId ?? userId`, so an account-blind key handed the second
     * seller on a device the first seller's entitlement.
     */
    @Test
    fun cachedGet_isNotSharedAcrossOwners() = runTest {
        server.enqueue(MockResponse().setBody("""{"owner":"a"}"""))
        server.enqueue(MockResponse().setBody("""{"owner":"b"}"""))

        val a = api(cacheOwner = "user-a")
        val b = api(cacheOwner = "user-b")
        assertEquals("""{"owner":"a"}""", a.getRaw("/api/profiles", cacheTtlMillis = 60_000))
        assertEquals("""{"owner":"b"}""", b.getRaw("/api/profiles", cacheTtlMillis = 60_000))
        assertEquals(2, server.requestCount)
    }

    /**
     * The SAME instance across a workspace switch - the shape a singleton
     * EdgeApi actually meets, since the instance outlives the selection.
     */
    @Test
    fun cachedGet_reFetchesWhenTheActiveOwnerChanges() = runTest {
        server.enqueue(MockResponse().setBody("""{"owner":"personal"}"""))
        server.enqueue(MockResponse().setBody("""{"owner":"team"}"""))

        var owner = "user-a"
        val shared = EdgeApi(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            client = OkHttpClient(),
            tokenProvider = { token },
            tokenRefresher = { null },
            cacheOwnerProvider = { owner },
            sleeper = {},
        )
        assertEquals("""{"owner":"personal"}""", shared.getRaw("/api/profiles", cacheTtlMillis = 60_000))
        owner = "team-owner"
        assertEquals("""{"owner":"team"}""", shared.getRaw("/api/profiles", cacheTtlMillis = 60_000))
        assertEquals(2, server.requestCount)
    }

    /** No tenant, no caching: an unscoped key is one somebody else can read. */
    @Test
    fun cachedGet_doesNotCacheWithoutAnOwner() = runTest {
        server.enqueue(MockResponse().setBody("""{"n":1}"""))
        server.enqueue(MockResponse().setBody("""{"n":2}"""))
        val a = api(cacheOwner = null)
        assertEquals("""{"n":1}""", a.getRaw("/api/list", cacheTtlMillis = 60_000))
        assertEquals("""{"n":2}""", a.getRaw("/api/list", cacheTtlMillis = 60_000))
        assertEquals(2, server.requestCount)
    }

    /**
     * The retention half. The key already stops the WRONG ANSWER being served;
     * this is about not holding the previous account's bytes in memory for an
     * hour after they sign out.
     */
    @Test
    fun clearAllResponseCaches_dropsEveryInstancesEntries() = runTest {
        server.enqueue(MockResponse().setBody("""{"n":1}"""))
        server.enqueue(MockResponse().setBody("""{"n":2}"""))
        val a = api()
        assertEquals("""{"n":1}""", a.getRaw("/api/list", cacheTtlMillis = 60_000))
        EdgeApi.clearAllResponseCaches()
        assertEquals("""{"n":2}""", a.getRaw("/api/list", cacheTtlMillis = 60_000))
        assertEquals(2, server.requestCount)
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

    /**
     * The entry cap's evictions have to be SUBTRACTED from the byte total.
     *
     * The test above never caught this because its values are one character
     * long: the drift was one byte per eviction against a 100-byte cap, so it
     * would have taken a hundred puts to show. With values large enough to
     * matter, a cache that has evicted many entries used to believe it was
     * full of bytes it no longer held, and then dropped everything on every
     * write - a cache that reports healthy and never returns a hit.
     *
     * Written against BEHAVIOUR rather than the private counter: after all
     * this churn the cache must still serve the entries it just stored.
     */
    @Test
    fun ttlCache_keepsServingAfterManyEntryCapEvictions() {
        val cache = TtlCache(maxEntries = 4, maxBytes = 1_000)
        val value = "x".repeat(100)
        // 50 puts against a 4-entry cap = 46 evictions = 4,600 leaked bytes
        // under the old accounting, against a 1,000-byte cap.
        repeat(50) { cache.put("k$it", value, ttlMillis = 60_000) }

        // The cap is 4 entries and 400 bytes fits in 1,000, so the last four
        // written are all still there.
        assertEquals(value, cache.get("k49"))
        assertEquals(value, cache.get("k48"))
        assertEquals(value, cache.get("k47"))
        assertEquals(value, cache.get("k46"))
        // And the one before them fell out to the ENTRY cap, as it should.
        assertNull(cache.get("k45"))
    }
}
