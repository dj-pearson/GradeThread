package com.gradethread.app.capture

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.gradethread.app.platform.net.EdgeApi

/**
 * US-1326: profile resolution, wire→slot mapping, the bundled fallback, and
 * the fetch behavior against a real HTTP server.
 */
class PhotoProfileTest {

    /**
     * US-2496: the owner is a PROVIDER, not a fixed value, because the store
     * and the EdgeApi under it are both singletons that outlive the account -
     * the tests have to be able to move the tenant under a live instance.
     */
    private fun api(server: MockWebServer, owner: () -> String? = { "user-a" }) = EdgeApi(
        baseUrl = server.url("/").toString().trimEnd('/'),
        client = OkHttpClient(),
        tokenProvider = { "token" },
        tokenRefresher = { "token" },
        cacheOwnerProvider = owner,
    )

    /** A store for one signed-in tenant. US-2496: there is no tenant-less one. */
    private fun newStore(server: MockWebServer, owner: () -> String? = { "user-a" }) =
        PhotoProfileStore(api(server, owner), owner)

    // ── Model mapping ──

    @Test
    fun slots_resolveFromServerTypes_droppingUnknowns() {
        val profile = PhotoProfile(
            category = "watch",
            label = "Watch",
            roles = listOf(
                PhotoRole("front", "Face", "Dial straight on", required = true, icon = "watch"),
                PhotoRole("serial", "Serial", "Caseback engraving", required = true, icon = "hash"),
                PhotoRole("angle", "Profile", "Side profile", required = false, icon = "image"),
                PhotoRole("defect", "Defect", "Any flaw", required = false, icon = "alert"),
                PhotoRole("hologram", "Hologram", "A type we don't know yet", required = true, icon = "x"),
            ),
        )
        // Unknown server types are dropped, not crashed on.
        assertEquals(listOf(PhotoSlotType.FRONT, PhotoSlotType.SERIAL), profile.requiredSlots)
        // Defects are EXCLUDED from optionals — their reveal flow owns them (AC3).
        assertEquals(listOf(PhotoSlotType.ANGLE), profile.optionalSlots)
        assertTrue(profile.allowsDefects)
        assertEquals("Caseback engraving", profile.roleForServerType("serial")?.hint)
        assertNull(profile.roleForServerType("nope"))
    }

    @Test
    fun bundledFallback_matchesTheIosTable() {
        val clothing = PhotoProfile.clothingFallback
        // US-2498: the bundled copy is the SERVER's clothing profile now, and
        // the server marks only front and back required — the tag and detail
        // roles are named, plural and optional. It used to be a five-role stub
        // whose tag and detail were both required and neither was named.
        assertEquals(
            listOf(PhotoSlotType.FRONT, PhotoSlotType.BACK),
            clothing.requiredSlots,
        )
        assertEquals(
            listOf("brand", "size", "care", "made_in"),
            clothing.roles.filter { it.type == "tag" }.map { it.role },
        )
        assertTrue(clothing.roles.any { it.type == "on_hanger" })
        assertTrue(clothing.allowsDefects)
        val other = PhotoProfile.genericFallback
        assertEquals(listOf(PhotoSlotType.FRONT, PhotoSlotType.BACK), other.requiredSlots)
        // US-2812: `shoes` joined the bundled table. Before it, a shoe
        // captured while the profile fetch was unavailable fell to the
        // clothing profile and was offered no Sole slot at all — the one
        // surface a shoe buyer looks at first.
        assertEquals(setOf("clothing", "shoes", "other"), PhotoProfile.bundledFallback.keys)

        val shoes = PhotoProfile.shoesFallback
        // Four required, and SOLE is the one worth asserting by name: it is
        // what separates this profile from the clothing one it used to fall
        // back to.
        assertEquals(
            listOf(
                PhotoSlotType.FRONT,
                PhotoSlotType.BACK,
                PhotoSlotType.ANGLE,
                PhotoSlotType.SOLE,
            ),
            shoes.requiredSlots,
        )
        assertEquals("Size Stamp", shoes.roles.first { it.type == "tag" }.label)
        assertTrue(shoes.allowsDefects)
    }

    // ── Store resolution ──

    @Test
    fun unknownOrNullCategory_fallsBackToClothing() = runTest {
        val server = MockWebServer()
        server.start()
        val store = newStore(server)
        assertEquals("clothing", store.profileFor(null).category)
        assertEquals("clothing", store.profileFor("weird-category").category)
        assertEquals("other", store.profileFor("other").category)
        server.shutdown()
    }

    @Test
    fun serverTable_replacesTheFallback_andLabelsFollowCategory() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(
            MockResponse().setBody(
                """{"profiles":{"clothing":{"category":"clothing","label":"Clothing","roles":[]},
                   "watch":{"category":"watch","label":"Watches","roles":[
                     {"type":"front","label":"Face","hint":"Dial straight on","required":true,"icon":"watch"}
                   ]}}}""",
            ),
        )
        val store = newStore(server)
        store.loadIfNeeded()

        // AC2: labels/hints update per category once the table lands.
        val watch = store.profileFor("watch")
        assertEquals("Face", watch.roleForServerType("front")?.label)
        assertEquals(1, server.requestCount)

        // Second call: loaded — no refetch.
        store.loadIfNeeded()
        assertEquals(1, server.requestCount)
        server.shutdown()
    }

    @Test
    fun fetchFailure_keepsTheBundledFallback() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setResponseCode(500).setBody("{}"))
        val store = newStore(server)
        store.loadIfNeeded()
        // Still resolvable — capture never blocks on the network.
        assertEquals("clothing", store.profileFor("clothing").category)
        assertFalse(store.profileFor(null).roles.isEmpty())
        server.shutdown()
    }

    // -- Tenant boundary (US-2496) --

    /**
     * The store is a process-wide singleton, so the SAME instance sees the
     * sign-out and the next sign-in. The table it holds encodes an entitlement
     * (the authenticity macros are dropped for a seller who cannot use them),
     * so serving the previous account's table to the next one is a wrong
     * answer, not a stale one.
     */
    @Test
    fun tableIsNotServedToAnotherTenant() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setBody(watchTable))

        var owner: String? = "user-a"
        val store = newStore(server) { owner }
        store.loadIfNeeded()
        assertEquals("Watches", store.profileFor("watch").label)

        // Sign out: nothing to serve, and nothing to load for.
        owner = null
        assertEquals("clothing", store.profileFor("watch").category)
        store.loadIfNeeded()
        assertEquals(1, server.requestCount)

        // A different seller on the same phone reads the bundled fallback until
        // their own table lands - never user-a's.
        owner = "user-b"
        assertEquals("clothing", store.profileFor("watch").category)

        server.enqueue(MockResponse().setBody(watchTable))
        store.loadIfNeeded()
        assertEquals(2, server.requestCount)
        assertEquals("Watches", store.profileFor("watch").label)
        server.shutdown()
    }

    /** A workspace switch changes the owner, so it refetches like a sign-in. */
    @Test
    fun workspaceSwitchRefetchesTheTable() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setBody(watchTable))
        server.enqueue(MockResponse().setBody(watchTable))

        var owner = "user-a"
        val store = newStore(server) { owner }
        store.loadIfNeeded()
        store.loadIfNeeded()
        assertEquals(1, server.requestCount)

        owner = "team-owner-id"
        store.loadIfNeeded()
        assertEquals(2, server.requestCount)
        server.shutdown()
    }

    private val watchTable = """{"profiles":{"watch":{"category":"watch","label":"Watches",
        "roles":[{"type":"front","label":"Face","hint":"Dial","required":true,"icon":"watch"}]}}}"""

    @Test
    fun wireDecode_toleratesUnknownJsonKeys() {
        val json = Json { ignoreUnknownKeys = true }
        val decoded = json.decodeFromString(
            PhotoProfileStore.Wrapper.serializer(),
            """{"profiles":{"x":{"category":"x","label":"X","roles":[],"future_field":1}},"extra":true}""",
        )
        assertEquals("X", decoded.profiles["x"]?.label)
    }
}
