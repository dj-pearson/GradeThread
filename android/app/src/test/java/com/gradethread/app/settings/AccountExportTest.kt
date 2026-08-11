package com.gradethread.app.settings

import android.content.Context
import androidx.test.core.app.ApplicationProvider
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
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * US-2412: the data-access export.
 *
 * The assertion that matters most is a negative one: the request carries no
 * user id. A data-access endpoint that took an id from its caller would be one
 * changed character away from handing a person somebody else's account.
 */
@RunWith(RobolectricTestRunner::class)
class AccountExportTest {

    private lateinit var server: MockWebServer
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun service() = AccountExportService(
        context,
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
    fun `the export is a plain GET carrying no user id`() = runTest {
        respond(200, """{"exported_at":"2026-08-11T00:00:00Z","user_id":"u1","profile":{}}""")
        service().export()

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        // No query string and no body: the server reads the subject from the
        // bearer token, and there is nothing here a caller could change.
        assertEquals(AccountExportService.EXPORT_PATH, request.path)
        assertEquals(0, request.bodySize)
        assertTrue(request.getHeader("Authorization")!!.startsWith("Bearer "))
    }

    @Test
    fun `the file lands in its own private cache directory, not shared storage`() = runTest {
        respond(200, """{"exported_at":"2026-08-11T00:00:00Z"}""")
        val file = service().export()

        // The whole account in one document. A copy in Downloads would be a
        // second permanent one that nothing sweeps.
        assertEquals(File(context.cacheDir, AccountExportService.DIR), file.parentFile)
        assertEquals(AccountExportService.FILE_NAME, file.name)
        assertTrue(file.readText().contains("exported_at"))
    }

    @Test
    fun `yesterday's export is gone before today's is written`() = runTest {
        val dir = File(context.cacheDir, AccountExportService.DIR).apply { mkdirs() }
        val stale = File(dir, "stale.json").apply { writeText("old") }

        respond(200, """{"exported_at":"2026-08-11T00:00:00Z"}""")
        service().export()

        // The share sheet gives no reliable "finished" callback, so sweeping
        // before the write is the guarantee that can actually be kept.
        assertFalse(stale.exists())
    }

    @Test
    fun `a failed export leaves no half-written file behind`() = runTest {
        service().sweep()
        // A 5xx on a GET is retried, so three responses for three attempts.
        repeat(3) { respond(500, """{"error":"Something went wrong"}""") }
        val error = runCatching { service().export() }.exceptionOrNull()

        assertTrue("was $error", error is EdgeApiError.ServerError)
        assertFalse(File(File(context.cacheDir, AccountExportService.DIR), AccountExportService.FILE_NAME).exists())
        assertEquals("Something went wrong", AccountExportService.message(error!!))
    }

    @Test
    fun `sweep clears the staged export`() {
        val dir = File(context.cacheDir, AccountExportService.DIR).apply { mkdirs() }
        File(dir, AccountExportService.FILE_NAME).writeText("{}")
        service().sweep()
        assertEquals(0, dir.listFiles()?.size ?: 0)
    }
}
