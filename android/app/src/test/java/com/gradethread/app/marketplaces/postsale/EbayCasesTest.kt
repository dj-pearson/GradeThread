package com.gradethread.app.marketplaces.postsale

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2409: the open/closed rule and the deadline maths, asserted against the
 * SHARED fixture the web suite reads
 * (`src/test/fixtures/post-sale-state-cases.json`).
 *
 * The rule now exists twice, in TypeScript and in Kotlin, and a source diff
 * cannot guard a port across languages. Reading the same file is the guard: if
 * the web changes a terminal marker and does not change the port, a case here
 * turns red naming the state.
 */
class EbayCasesTest {

    private val fixture: JsonObject = loadFixture()

    private fun cases(key: String): List<JsonObject> =
        fixture[key]?.jsonArray?.map { it.jsonObject }.orEmpty()

    private fun JsonObject.str(key: String): String? =
        this[key]?.takeIf { it != JsonNull }?.jsonPrimitive?.content

    @Test
    fun `the fixture is the one the web suite reads`() {
        // A fixture that silently failed to load would make every case below
        // pass over an empty list — the failure a shared-file guard is most
        // exposed to.
        assertTrue("no isClosed cases", cases("isClosed").isNotEmpty())
        assertTrue("no daysUntil cases", cases("daysUntil").isNotEmpty())
    }

    @Test
    fun `every recorded state is classified the same way as on the web`() {
        for (case in cases("isClosed")) {
            val expected = case.getValue("closed").jsonPrimitive.content.toBoolean()
            val why = case.str("why").orEmpty()
            assertEquals(
                "state=${case.str("state")} status=${case.str("status")}: $why",
                expected,
                EbayCases.isClosed(case.str("state"), case.str("status")),
            )
        }
    }

    @Test
    fun `the days to a deadline are counted the same way as on the web`() {
        for (case in cases("daysUntil")) {
            val now = EbayCases.parseInstant(case.str("nowIso"))!!
            val expected = case["days"]?.takeIf { it != JsonNull }?.jsonPrimitive?.long
            assertEquals(
                "${case.str("atIso")} from ${case.str("nowIso")}",
                expected,
                EbayCases.daysUntil(case.str("atIso"), now),
            )
        }
    }

    @Test
    fun `overdue follows the same cases`() {
        for (case in cases("daysUntil")) {
            val now = EbayCases.parseInstant(case.str("nowIso"))!!
            val days = case["days"]?.takeIf { it != JsonNull }?.jsonPrimitive?.long
            assertEquals(
                "overdue for ${case.str("atIso")}",
                days != null && days < 0,
                EbayCases.isOverdue(case.str("atIso"), now),
            )
        }
    }

    // ── the Android side of the same rules ───────────────────────────────

    @Test
    fun `a refund the seller still owes is open, not closed`() {
        // The single most important case in this file. REFUND_OVERDUE is the
        // most urgent OPEN state there is, and matching the bare word REFUND
        // would bury exactly the row that needs action most.
        assertFalse(EbayCases.isClosed(EbayReturn(returnId = "r1", state = "REFUND_OVERDUE")))
        assertTrue(EbayCases.isClosed(EbayReturn(returnId = "r2", state = "REFUNDED")))
    }

    @Test
    fun `each case type reads its own status field`() {
        assertTrue(EbayCases.isClosed(EbayCancellation(cancelId = "c1", state = "CANCEL_CLOSED")))
        assertFalse(EbayCases.isClosed(EbayCancellation(cancelId = "c2", state = "CANCEL_REQUESTED")))
        // Disputes carry `status`, not `state` — the typed overload has to
        // reach for the right one or every dispute would read as open.
        assertTrue(EbayCases.isClosed(EbayPaymentDispute(paymentDisputeId = "d1", status = "CLOSED")))
        assertFalse(
            EbayCases.isClosed(EbayPaymentDispute(paymentDisputeId = "d2", status = "ACTION_NEEDED")),
        )
    }

    @Test
    fun `an unreadable deadline produces no badge rather than an invented one`() {
        val now = EbayCases.parseInstant("2026-08-11T00:00:00Z")!!
        assertNull(EbayCases.daysUntil("whenever", now))
        assertFalse(EbayCases.isOverdue("whenever", now))
        assertNull(EbayCases.parseInstant(null))
        assertNull(EbayCases.parseInstant("  "))
    }

    private companion object {
        const val FIXTURE = "src/test/fixtures/post-sale-state-cases.json"

        /**
         * Walk up from the working directory to the repo root.
         *
         * Gradle runs unit tests with `user.dir` at the module, and the fixture
         * is deliberately in the WEB tree — it belongs to whichever suite reads
         * it first, and copying it into `android/` would recreate the drift it
         * exists to prevent.
         */
        fun loadFixture(): JsonObject {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            val tried = mutableListOf<String>()
            while (dir != null) {
                val candidate = File(dir, FIXTURE)
                tried += candidate.path
                if (candidate.isFile) {
                    return Json.parseToJsonElement(candidate.readText(Charsets.UTF_8)).jsonObject
                }
                dir = dir.parentFile
            }
            throw AssertionError(
                "Shared fixture $FIXTURE not found. Looked at:\n" + tried.joinToString("\n"),
            )
        }
    }
}
