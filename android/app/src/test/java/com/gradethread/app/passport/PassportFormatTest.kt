package com.gradethread.app.passport

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1376: the confidence taxonomy and the timeline's ordering. A passport is a
 * provenance claim somebody may pay on, so the tests care most about never
 * over-claiming a link.
 */
class PassportFormatTest {

    private fun event(
        type: String = "graded",
        confidence: String = "deterministic",
        at: String = "2026-06-20T10:00:00Z",
        actor: String? = null,
        revealed: PassportVerifiedSeller? = null,
        payload: PassportEventPayload = PassportEventPayload(),
    ) = PassportEvent(
        eventType = type,
        confidence = confidence,
        actor = actor,
        actorRevealed = revealed,
        payload = payload,
        createdAt = at,
    )

    // ── Confidence ───────────────────────────────────────────────────────────

    @Test
    fun `there are exactly three levels and nothing else maps to verified`() {
        // An unrecognized value must never read as proven. A future enum entry
        // arriving as "verified" would be a claim the ledger never made.
        assertEquals(PassportConfidence.DETERMINISTIC, PassportConfidence.of("deterministic"))
        assertEquals(PassportConfidence.PROBABLE, PassportConfidence.of("probable"))
        assertEquals(PassportConfidence.UNKNOWN, PassportConfidence.of("unknown"))
        assertEquals(PassportConfidence.UNKNOWN, PassportConfidence.of(null))
        assertEquals(PassportConfidence.UNKNOWN, PassportConfidence.of("something_new"))
        assertEquals(PassportConfidence.UNKNOWN, PassportConfidence.of("DETERMINISTIC"))
    }

    @Test
    fun `only the proven level says verified`() {
        assertEquals("Verified", PassportConfidence.DETERMINISTIC.label)
        assertEquals("Probable", PassportConfidence.PROBABLE.label)
        assertEquals("Unverified", PassportConfidence.UNKNOWN.label)
    }

    @Test
    fun `the softer levels never claim confirmation`() {
        // Legal safety, not tone: "confirmed" on an inferred link is a claim
        // nobody checked.
        listOf(PassportConfidence.PROBABLE, PassportConfidence.UNKNOWN).forEach { level ->
            val text = level.explanation.lowercase()
            assertTrue(level.name, !text.contains("confirmed"))
            assertTrue(level.name, !text.contains("guaranteed"))
        }
    }

    // ── Chain strength ───────────────────────────────────────────────────────

    @Test
    fun `an empty chain has no strength and says so`() {
        val strength = PassportChainStrength.of(emptyList())
        assertEquals(0, strength.total)
        assertEquals(0.0, strength.score, 0.0001)
        assertEquals("None", strength.label)
        assertEquals("No history recorded yet.", strength.summary)
    }

    @Test
    fun `strength bands follow the proven fraction`() {
        assertEquals("Strong", PassportChainStrength.of(List(4) { "deterministic" }).label)
        assertEquals(
            "Strong",
            PassportChainStrength.of(listOf("deterministic", "deterministic", "deterministic", "probable")).label,
        )
        assertEquals(
            "Moderate",
            PassportChainStrength.of(listOf("deterministic", "deterministic", "probable", "unknown", "unknown")).label,
        )
        assertEquals(
            "Emerging",
            PassportChainStrength.of(listOf("probable", "probable", "unknown")).label,
        )
    }

    @Test
    fun `the summary is a count, not an adjective on its own`() {
        // "3 of 5 verified" is checkable; "moderate" has to be trusted.
        val strength = PassportChainStrength.of(
            listOf("deterministic", "deterministic", "deterministic", "probable", "unknown"),
        )
        assertEquals("3 of 5 links are independently verified.", strength.summary)
        assertEquals(3, strength.deterministic)
        assertEquals(1, strength.probable)
        assertEquals(1, strength.unknown)
    }

    @Test
    fun `a single link reads as singular`() {
        assertEquals(
            "1 of 1 link is independently verified.",
            PassportChainStrength.of(listOf("deterministic")).summary,
        )
    }

    // ── Ordering ─────────────────────────────────────────────────────────────

    @Test
    fun `events render oldest first regardless of arrival order`() {
        // The edge orders these AND caches the assembled body. A timeline out of
        // order tells a false story about what happened to a garment.
        val ordered = PassportFormat.ordered(
            listOf(
                event(type = "sold", at = "2026-06-22T10:00:00Z"),
                event(type = "graded", at = "2026-06-20T10:00:00Z"),
                event(type = "listed", at = "2026-06-21T10:00:00Z"),
            ),
        )
        assertEquals(listOf("graded", "listed", "sold"), ordered.map { it.eventType })
    }

    @Test
    fun `an unparseable timestamp sinks to the end rather than to the start`() {
        // At the top it would claim to be the origin of the chain.
        val ordered = PassportFormat.ordered(
            listOf(
                event(type = "broken", at = "not a date"),
                event(type = "graded", at = "2026-06-20T10:00:00Z"),
            ),
        )
        assertEquals(listOf("graded", "broken"), ordered.map { it.eventType })
    }

    @Test
    fun `fractional seconds parse`() {
        // The edge emits them; a strict parser would drop every real event.
        assertTrue(PassportFormat.epochMillis("2026-06-20T10:00:00.412Z") < Long.MAX_VALUE)
    }

    @Test
    fun `an empty timeline produces no events and no error`() {
        val timeline = Json { ignoreUnknownKeys = true }
            .decodeFromString(PassportTimeline.serializer(), """{"slug":"abc"}""")

        assertEquals("abc", timeline.slug)
        assertTrue(timeline.events.isEmpty())
        assertEquals("None", PassportChainStrength.of(emptyList()).label)
    }

    // ── Labels ───────────────────────────────────────────────────────────────

    @Test
    fun `every enum event type has real wording`() {
        assertEquals("Condition graded", PassportFormat.eventLabel("graded"))
        assertEquals("Listed for sale", PassportFormat.eventLabel("listed"))
        assertEquals("Sold", PassportFormat.eventLabel("sold"))
        assertEquals("Ownership transferred", PassportFormat.eventLabel("ownership_transfer"))
        assertEquals("Fingerprinted", PassportFormat.eventLabel("fingerprinted"))
        // Added to the enum in migration 00488; iOS still falls through on it.
        assertEquals("Authenticity assessed", PassportFormat.eventLabel("authenticity_assessed"))
    }

    @Test
    fun `an unknown event type renders as itself, not as nothing`() {
        // Hiding a real event behind "Unknown" would say nothing happened.
        assertEquals("Repaired By Cobbler", PassportFormat.eventLabel("repaired_by_cobbler"))
    }

    @Test
    fun `title case handles both separators`() {
        assertEquals("Very Good", PassportFormat.titleCase("very-good"))
        assertEquals("Ownership Transfer", PassportFormat.titleCase("ownership_transfer"))
        assertEquals("", PassportFormat.titleCase(""))
    }

    @Test
    fun `the garment name comes from the descriptor, with a fallback`() {
        val sku = Json.decodeFromString(
            JsonObject.serializer(),
            """{"brand":"Patagonia","garment_type":"fleece_jacket","size":"M"}""",
        )
        assertEquals("Patagonia Fleece Jacket", PassportFormat.garmentName(sku))

        assertEquals("Graded garment", PassportFormat.garmentName(JsonObject(emptyMap())))
        assertEquals(
            "Graded garment",
            PassportFormat.garmentName(
                Json.decodeFromString(JsonObject.serializer(), """{"brand":"  "}"""),
            ),
        )
    }

    @Test
    fun `an unreadable date falls back to the raw string, never to blank`() {
        // Ugly still tells the reader when something happened; blank doesn't.
        assertEquals("not a date", PassportFormat.longDate("not a date"))
        assertEquals("", PassportFormat.longDate(""))
    }

    @Test
    fun `the grade line only appears when a grade is on the hop`() {
        assertNull(PassportFormat.gradeLine(event()))
        assertEquals(
            "9.2 · Excellent",
            PassportFormat.gradeLine(
                event(payload = PassportEventPayload(overallScore = 9.2, gradeTier = "excellent")),
            ),
        )
        assertEquals(
            "9.2",
            PassportFormat.gradeLine(event(payload = PassportEventPayload(overallScore = 9.2))),
        )
    }

    @Test
    fun `an actor-less hop names nobody`() {
        // Inventing "Unknown seller" would imply a person was involved when the
        // ledger says otherwise.
        assertNull(PassportFormat.actorLine(event()))
        assertEquals("Seller A", PassportFormat.actorLine(event(actor = "Seller A")))
    }

    @Test
    fun `a revealed identity wins over the pseudonym`() {
        assertEquals(
            "Ada Flips (verified)",
            PassportFormat.actorLine(
                event(
                    actor = "Seller A",
                    revealed = PassportVerifiedSeller(handle = "adaflips", displayName = "Ada Flips"),
                ),
            ),
        )
        assertEquals(
            "@adaflips (verified)",
            PassportFormat.actorLine(
                event(actor = "Seller A", revealed = PassportVerifiedSeller(handle = "adaflips")),
            ),
        )
    }

    @Test
    fun `the event key stays stable across identical hops`() {
        val a = event(type = "sold", at = "2026-06-22T10:00:00Z", actor = "Seller A")
        val b = event(type = "sold", at = "2026-06-22T10:00:00Z", actor = "Seller A")
        assertEquals(a.key, b.key)
        assertTrue(a.key.contains("sold"))
    }
}
