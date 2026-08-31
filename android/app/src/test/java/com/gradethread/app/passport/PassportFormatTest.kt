package com.gradethread.app.passport

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import com.gradethread.app.R
import java.io.File
import org.junit.Assert.assertNotNull
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
        // US-2976: three DISTINCT resources. Which level a link got is the
        // claim a buyer may pay on, and the ids say that as exactly as the
        // words did.
        assertEquals(
            R.string.passport_confidence_verified,
            PassportConfidence.DETERMINISTIC.label,
        )
        assertEquals(R.string.passport_confidence_probable, PassportConfidence.PROBABLE.label)
        assertEquals(R.string.passport_confidence_unverified, PassportConfidence.UNKNOWN.label)
    }

    @Test
    fun `the softer levels never claim confirmation, in any language`() {
        // Legal safety, not tone: "confirmed" on an inferred link is a claim
        // nobody checked.
        //
        // US-2976: this used to read PassportConfidence.explanation, which is a
        // resource id now. Asserting the id would have quietly DROPPED the
        // guarantee - so it reads the resource files instead, and in doing so
        // covers Spanish, which it never did. A translator writing "confirmado"
        // into the probable explanation is the exact failure this guards, and
        // until now nothing would have caught it.
        val forbidden = listOf("confirmed", "guaranteed", "confirmad", "garantizad")
        val softer = listOf(
            "passport_confidence_probable_why",
            "passport_confidence_unverified_why",
        )
        for (locale in listOf("values", "values-es")) {
            val xml = File("src/main/res/$locale/strings.xml").readText()
            for (name in softer) {
                val value = Regex("<string name=\"$name\">(.*?)</string>", RegexOption.DOT_MATCHES_ALL)
                    .find(xml)
                    ?.groupValues
                    ?.get(1)
                assertNotNull("$locale is missing $name", value)
                val text = value!!.lowercase()
                forbidden.forEach { word ->
                    assertTrue("$locale/$name claims \"$word\"", !text.contains(word))
                }
            }
        }
    }

    // ── Chain strength ───────────────────────────────────────────────────────

    @Test
    fun `an empty chain has no strength and says so`() {
        val strength = PassportChainStrength.of(emptyList())
        assertEquals(0, strength.total)
        assertEquals(0.0, strength.score, 0.0001)
        assertEquals(R.string.passport_strength_none, strength.label)
        assertEquals(R.string.passport_no_history, strength.summary.res)
    }

    @Test
    fun `strength bands follow the proven fraction`() {
        assertEquals(
            R.string.passport_strength_strong,
            PassportChainStrength.of(List(4) { "deterministic" }).label,
        )
        assertEquals(
            R.string.passport_strength_strong,
            PassportChainStrength.of(listOf("deterministic", "deterministic", "deterministic", "probable")).label,
        )
        assertEquals(
            R.string.passport_strength_moderate,
            PassportChainStrength.of(listOf("deterministic", "deterministic", "probable", "unknown", "unknown")).label,
        )
        assertEquals(
            R.string.passport_strength_emerging,
            PassportChainStrength.of(listOf("probable", "probable", "unknown")).label,
        )
    }

    @Test
    fun `the summary is a count, not an adjective on its own`() {
        // "3 of 5 verified" is checkable; "moderate" has to be trusted.
        val strength = PassportChainStrength.of(
            listOf("deterministic", "deterministic", "deterministic", "probable", "unknown"),
        )
        // Three verified OF five, in that order. Reversed, the line claims
        // five of three, which is the one arithmetic a buyer would notice.
        assertEquals(R.plurals.passport_verified_links, strength.summary.res)
        assertEquals(listOf<Any>(3, 5), strength.summary.args)
        // Pluralised on the TOTAL: "links are" agrees with the five.
        assertEquals(5, strength.summary.quantity)
        assertEquals(3, strength.deterministic)
        assertEquals(1, strength.probable)
        assertEquals(1, strength.unknown)
    }

    @Test
    fun `a single link reads as singular`() {
        val single = PassportChainStrength.of(listOf("deterministic")).summary
        assertEquals(R.plurals.passport_verified_links, single.res)
        assertEquals(1, single.quantity)
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
        assertEquals(
            R.string.passport_strength_none,
            PassportChainStrength.of(emptyList()).label,
        )
    }

    // ── Labels ───────────────────────────────────────────────────────────────

    @Test
    fun `every enum event type has real wording`() {
        // US-2976: `detail` being null is what says the lookup HIT. A type
        // that falls through carries the raw wire name instead, which is the
        // regression this test exists to catch.
        listOf(
            "graded" to R.string.passport_event_graded,
            "listed" to R.string.passport_event_listed,
            "sold" to R.string.passport_event_sold,
            "ownership_transfer" to R.string.passport_event_ownership_transfer,
            "fingerprinted" to R.string.passport_event_fingerprinted,
            // Added to the enum in migration 00488; iOS still falls through.
            "authenticity_assessed" to R.string.passport_event_authenticity_assessed,
        ).forEach { (wire, res) ->
            val label = PassportFormat.eventLabel(wire)
            assertEquals(wire, res, label.res)
            assertNull(wire, label.detail)
        }
    }

    @Test
    fun `an unknown event type renders as itself, not as nothing`() {
        // Hiding a real event behind "Unknown" would say nothing happened.
        val unknown = PassportFormat.eventLabel("repaired_by_cobbler")
        assertEquals(R.string.passport_event_other, unknown.res)
        // The server's own word, tidied and shown as-is.
        assertEquals("Repaired By Cobbler", unknown.detail)
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
