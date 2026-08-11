package com.gradethread.app.money

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.sync.db.PayoutEntity
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * US-2414: importing an eBay payouts CSV.
 *
 * The parsing and the dedup are the server's, next to the webhook that ingests
 * the same payouts live — one rule, so a file upload and a live deposit can
 * never disagree about whether a payout already exists. What is worth pinning
 * here is what the phone sends, what it does with the counts, and that the
 * imported rows feed the SAME reconciliation the synced ones do.
 */
class PayoutImportTest {

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

    private fun service() = PayoutImportService(
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
    fun `the CSV goes up whole, unparsed`() = runTest {
        respond(200, """{"imported":3,"skipped":1,"duplicates":0}""")
        val result = service().importCsv("Payout ID,Amount\nP1,10.00\n")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/flipdesk/ebay/payouts/import-csv", request.path)
        // Sent as one string, not fields: a phone-side parser would be a second
        // parser and a second dedup rule, free to disagree with the webhook's.
        assertEquals(
            """{"csv":"Payout ID,Amount\nP1,10.00\n"}""",
            request.body.readUtf8(),
        )
        assertEquals(3, result.imported)
        assertEquals(1, result.skipped)
    }

    @Test
    fun `a re-import reports the duplicates instead of double-counting`() = runTest {
        // The whole re-upload story. Nothing new landed, and the seller has to
        // be told that, or they go looking for money that was never missing.
        respond(200, """{"imported":0,"skipped":0,"duplicates":12}""")
        val result = service().importCsv("csv")
        assertEquals(0, result.imported)
        assertEquals(12, result.duplicates)
    }

    @Test
    fun `the wrong export names the report that was wanted`() = runTest {
        val sentence = "Could not find a payouts table in this CSV. Export the report " +
            "from Seller Hub → Payments → Payouts → Download."
        respond(400, """{"error":${kotlinx.serialization.json.JsonPrimitive(sentence)}}""")

        val error = runCatching { service().importCsv("order,report\n") }.exceptionOrNull()
        assertTrue("was $error", error is EdgeApiError.BadRequest)
        // Verbatim: a seller who downloaded the orders report instead has no
        // other way to learn which one they needed.
        assertEquals(sentence, PayoutImportService.message(error!!))
    }

    @Test
    fun `an oversized file is refused before it is sent`() {
        // Checked client-side because a 5MB upload over cellular is a slow way
        // to learn the answer was no.
        assertEquals(5 * 1024 * 1024, PayoutImportService.MAX_BYTES)
    }

    // ── the imported rows feed the existing reconciliation ───────────────

    private fun payout(id: String, cents: Int) = PayoutEntity(
        id = id,
        payoutId = id,
        amountCents = cents,
        currency = "USD",
        status = "SUCCEEDED",
        payoutDate = 0L,
        transactionCount = null,
        updatedAt = 0L,
    )

    @Test
    fun `a CSV-sourced payout reconciles exactly like a webhook one`() {
        // This is AC2: the import feeds the reconciliation that already
        // exists rather than a second, parallel comparison. The source column
        // says csv_upload and nothing in the matching looks at it.
        val reconciled = PayoutReconciliation.reconcile(
            payouts = listOf(payout("P1", 4200)),
            sales = listOf(
                MoneyFixtures.sale("s1", "i1", payoutReference = "P1", payoutAmount = 42.0),
            ),
        )
        assertEquals(1, reconciled.size)
        assertEquals(4200, reconciled.single().recordedCents)
        assertTrue(reconciled.single().matched)
        assertTrue(PayoutReconciliation.mismatches(reconciled).isEmpty())
    }
}
