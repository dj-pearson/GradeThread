package com.gradethread.app.importer

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * US-2410: pulling a Google Sheet, and what happens when it is not shared.
 *
 * The unshared case is the one that matters. It is by far the most common
 * failure, the fix is four taps inside Google, and the ONLY place those four
 * taps are named is the server's own sentence — so these tests are mostly
 * asking whether that sentence survives the trip to the screen intact.
 */
class SheetsImportTest {

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

    private fun service() = SheetsImportService(
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
    fun `a fetch posts the trimmed url and returns the csv`() = runTest {
        respond(200, """{"csv":"sku,title\nA1,Jacket","gid":"0","spreadsheet_id":"1AbC"}""")
        val csv = service().fetchCsv("  https://docs.google.com/spreadsheets/d/1AbC/edit  ")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/flipdesk/sheets/fetch-csv", request.path)
        assertEquals(
            """{"url":"https://docs.google.com/spreadsheets/d/1AbC/edit"}""",
            request.body.readUtf8(),
        )
        assertTrue(csv.startsWith("sku,title"))
    }

    @Test
    fun `an unshared sheet names the exact setting to change`() = runTest {
        // The server sends this because it is the only party that can tell an
        // unshared sheet from an unreachable one — Google answers an unshared
        // sheet with a 200 carrying a login page.
        val sentence = "That sheet isn't shared publicly. Open it → Share → " +
            "General access → \"Anyone with the link\" (Viewer), then retry."
        respond(403, """{"error":${quote(sentence)}}""")

        val error = runCatching { service().fetchCsv("https://docs.google.com/spreadsheets/d/1/edit") }
            .exceptionOrNull()

        // Forbidden, not Unauthorized: a 403 explained in a sentence is a
        // permission ANSWER. Folded into "your session expired" the seller
        // would be sent to a sign-out that cannot fix a sharing setting.
        assertTrue("was $error", error is EdgeApiError.Forbidden)
        assertEquals(sentence, SheetsImportService.message(error!!))
    }

    @Test
    fun `the other unshared shape is shown verbatim too`() = runTest {
        // Google refuses outright rather than redirecting. Different sentence,
        // same requirement: it names Share → General access.
        val sentence = "Couldn't read that sheet. Open it → Share → General access → " +
            "set to \"Anyone with the link\" (Viewer), then try again."
        respond(403, """{"error":${quote(sentence)}}""")

        val error = runCatching { service().fetchCsv("https://docs.google.com/spreadsheets/d/1/edit") }
            .exceptionOrNull()
        assertEquals(sentence, SheetsImportService.message(error!!))
    }

    @Test
    fun `a link that is not a Google Sheet says so instead of failing blankly`() = runTest {
        val sentence = "That doesn't look like a Google Sheets link. Copy the URL from " +
            "your browser's address bar while the sheet is open."
        respond(400, """{"error":${quote(sentence)}}""")

        val error = runCatching { service().fetchCsv("https://example.com/thing") }.exceptionOrNull()
        assertTrue(error is EdgeApiError.BadRequest)
        assertEquals(sentence, SheetsImportService.message(error!!))
    }

    @Test
    fun `a sheet too big to import reports its own limit`() = runTest {
        respond(413, """{"error":"Sheet is too large (>10MB of CSV)."}""")
        val error = runCatching { service().fetchCsv("https://docs.google.com/spreadsheets/d/1/edit") }
            .exceptionOrNull()
        assertEquals("Sheet is too large (>10MB of CSV).", SheetsImportService.message(error!!))
    }

    @Test
    fun `a fetched sheet feeds the same parser a picked file does`() {
        // The promise that local import is unchanged rests on this: whatever
        // comes back is CSV text, and CSV text has exactly one parser.
        val sheet = CsvParser.parseSheet("sku,title,price\nA1,\"Wool coat, navy\",42.50\n")
        assertEquals(listOf("sku", "title", "price"), sheet.headers)
        assertEquals(listOf("A1", "Wool coat, navy", "42.50"), sheet.rows.single())
    }

    /** JSON-quote a sentence containing quotes and arrows, for the fake body. */
    private fun quote(text: String): String = JsonPrimitive(text).toString()
}
