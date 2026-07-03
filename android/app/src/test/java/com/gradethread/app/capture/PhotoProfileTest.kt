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

    private fun api(server: MockWebServer) = EdgeApi(
        baseUrl = server.url("/").toString().trimEnd('/'),
        client = OkHttpClient(),
        tokenProvider = { "token" },
        tokenRefresher = { "token" },
    )

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
        assertEquals(
            listOf(PhotoSlotType.FRONT, PhotoSlotType.BACK, PhotoSlotType.TAG, PhotoSlotType.DETAIL),
            clothing.requiredSlots,
        )
        assertTrue(clothing.allowsDefects)
        val other = PhotoProfile.genericFallback
        assertEquals(listOf(PhotoSlotType.FRONT, PhotoSlotType.BACK), other.requiredSlots)
        assertEquals(setOf("clothing", "other"), PhotoProfile.bundledFallback.keys)
    }

    // ── Store resolution ──

    @Test
    fun unknownOrNullCategory_fallsBackToClothing() = runTest {
        val server = MockWebServer()
        server.start()
        val store = PhotoProfileStore(api(server))
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
        val store = PhotoProfileStore(api(server))
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
        val store = PhotoProfileStore(api(server))
        store.loadIfNeeded()
        // Still resolvable — capture never blocks on the network.
        assertEquals("clothing", store.profileFor("clothing").category)
        assertFalse(store.profileFor(null).roles.isEmpty())
        server.shutdown()
    }

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
