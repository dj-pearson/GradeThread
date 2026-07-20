package com.gradethread.app.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1334: the `/api/flipdesk/ai/extract` wire contract.
 *
 * The load-bearing property is that map KEYS are inventory field names and
 * must survive (de)serialization byte-for-byte. A naming strategy applied to
 * this module would rewrite `garment_category` and break every lookup while
 * still parsing cleanly — so it is asserted, not assumed.
 */
class AiExtractWireTest {

    @Test
    fun snakeCaseFieldNameKeysSurviveDecoding() {
        val json = """
            {"suggestions":{"garment_category":{"value":"hoodie","confidence":0.9,"source":"photo:front"},
            "condition_notes":{"value":"light pilling","confidence":0.8,"source":"photo:detail"}},
            "actions_remaining":4}
        """.trimIndent()
        val response = aiExtractJson.decodeFromString(AiExtractResponse.serializer(), json)
        // Not "garmentCategory".
        assertEquals("hoodie", response.suggestions["garment_category"]?.value)
        assertEquals("light pilling", response.suggestions["condition_notes"]?.value)
        assertEquals(4, response.actionsRemaining)
    }

    @Test
    fun fieldNameKeysSurviveARoundTrip() {
        val original = AiExtractResponse(
            suggestions = mapOf("garment_category" to FieldSuggestion("hoodie", 0.9, "photo:front")),
        )
        val encoded = aiExtractJson.encodeToString(AiExtractResponse.serializer(), original)
        assertTrue(encoded.contains("garment_category"))
        assertFalse(encoded.contains("garmentCategory"))
        val decoded = aiExtractJson.decodeFromString(AiExtractResponse.serializer(), encoded)
        assertEquals(original.suggestions, decoded.suggestions)
    }

    @Test
    fun envelopeKeysAreSnakeCaseOnTheWire() {
        val json = """
            {"suggestions":{},"condition_summary":"Good","log_id":"abc",
            "actions_remaining":2,"ebay_pending":true,"ebay_category_query":"mens hoodie"}
        """.trimIndent()
        val response = aiExtractJson.decodeFromString(AiExtractResponse.serializer(), json)
        assertEquals("Good", response.conditionSummary)
        assertEquals("abc", response.logId)
        assertEquals(2, response.actionsRemaining)
        assertTrue(response.ebayPending)
        assertEquals("mens hoodie", response.ebayCategoryQuery)
    }

    @Test
    fun aMinimalResponseDecodes() {
        // The server omits most keys on a thin result; absent must not throw.
        val response = aiExtractJson.decodeFromString(
            AiExtractResponse.serializer(), """{"suggestions":{}}""",
        )
        assertTrue(response.suggestions.isEmpty())
        assertTrue(response.conflicts.isEmpty())
        assertNull(response.measurements)
        assertEquals(AiExtractResponse.ACTIONS_REMAINING_UNKNOWN, response.actionsRemaining)
    }

    @Test
    fun unknownServerKeysAreIgnored() {
        // The server ships new keys ahead of the client routinely.
        val response = aiExtractJson.decodeFromString(
            AiExtractResponse.serializer(),
            """{"suggestions":{},"some_future_key":{"nested":true}}""",
        )
        assertTrue(response.suggestions.isEmpty())
    }

    @Test
    fun aNullEbayBlockDoesNotBreakDecoding() {
        // The server now always returns ebay:null — the phase moved to a
        // background pass. We must tolerate it without modelling the dead path.
        val response = aiExtractJson.decodeFromString(
            AiExtractResponse.serializer(),
            """{"suggestions":{},"ebay":null,"ebay_pending":true}""",
        )
        assertTrue(response.ebayPending)
    }

    @Test
    fun conflictsDecodeWithTheirSnakeCaseValues() {
        val response = aiExtractJson.decodeFromString(
            AiExtractResponse.serializer(),
            """{"suggestions":{},"conflicts":[{"field":"size","text_value":"M","photo_value":"L"}]}""",
        )
        val conflict = response.conflicts.single()
        assertEquals("size", conflict.field)
        assertEquals("M", conflict.textValue)
        assertEquals("L", conflict.photoValue)
    }

    @Test
    fun researchBlockDecodes() {
        val response = aiExtractJson.decodeFromString(
            AiExtractResponse.serializer(),
            """{"suggestions":{},"research":{"identified_style":"Synchilla",
            "identification_rationale":"Fleece texture and logo","identification_confidence":0.8}}""",
        )
        assertEquals("Synchilla", response.research?.identifiedStyle)
        assertEquals("Fleece texture and logo", response.research?.rationale)
    }

    @Test
    fun requestSerializesTypedPhotosAndSnakeCaseKeys() {
        val request = AiExtractRequest(
            itemId = "item-1",
            photos = listOf(AiExtractPhoto("https://x/1.jpg", "front")),
            knownFields = mapOf("brand" to "Nike"),
            text = "vintage",
        )
        val encoded = aiExtractJson.encodeToString(AiExtractRequest.serializer(), request)
        assertTrue(encoded.contains("\"item_id\":\"item-1\""))
        assertTrue(encoded.contains("\"known_fields\""))
        // Typed photos, never a bare photo_urls array.
        assertTrue(encoded.contains("\"type\":\"front\""))
        assertFalse(encoded.contains("photo_urls"))
    }

    @Test
    fun nullsAreOmittedRatherThanSentExplicitly() {
        val encoded = aiExtractJson.encodeToString(
            AiExtractRequest.serializer(), AiExtractRequest(itemId = "i"),
        )
        assertFalse(encoded.contains("known_fields"))
        assertFalse(encoded.contains("\"text\""))
    }

    @Test
    fun feedbackSerializesBothChannels() {
        val encoded = aiExtractJson.encodeToString(
            AiLogFeedback.serializer(),
            AiLogFeedback(
                acceptedFields = mapOf("brand" to "Nike"),
                correctedFields = mapOf("size" to AiCorrection("L", "M")),
            ),
        )
        assertTrue(encoded.contains("\"accepted_fields\""))
        assertTrue(encoded.contains("\"corrected_fields\""))
        // `final` is a soft keyword in Kotlin but a plain JSON key here.
        assertTrue(encoded.contains("\"final\":\"M\""))
    }

    @Test
    fun extractPathTargetsTheEdgeService() {
        // functions.gradethread.com, not api.* — the latter is Supabase-only
        // and would 404 this path.
        assertEquals("/api/flipdesk/ai/extract", AiExtractService.EXTRACT_PATH)
        assertEquals("/api/flipdesk/ai/log/abc", AiExtractService.logPath("abc"))
    }

    @Test
    fun sourceLabelsMatchIosStringForString() {
        fun label(source: String) =
            FieldSuggestionEntry("size", FieldSuggestion("M", 0.5, source)).sourceLabel
        assertEquals("From description", label("text"))
        assertEquals("On-device OCR", label("live-text"))
        assertEquals("Identified from product knowledge", label("research"))
        assertEquals("Tag value — conflicts with photo", label("conflict:tag"))
        assertEquals("Photos disagree on this — verify", label("conflict:photo"))
        assertEquals("From front photo", label("photo:front"))
        assertEquals("From defect photo", label("photo:defect"))
        // An unrecognized source falls through verbatim rather than vanishing.
        assertEquals("something-new", label("something-new"))
    }

    @Test
    fun displayLabelsAreHumanReadable() {
        assertEquals(
            "Garment Category",
            FieldSuggestionEntry("garment_category", FieldSuggestion("x", 1.0, "s")).displayLabel,
        )
    }

    @Test
    fun confidenceIsClampedDefensively() {
        fun clamped(c: Double) =
            FieldSuggestionEntry("size", FieldSuggestion("M", c, "s")).clampedConfidence
        // A bad value must not produce a negative or overlong progress bar.
        assertEquals(0.0, clamped(-1.0), 1e-9)
        assertEquals(1.0, clamped(4.0), 1e-9)
    }
}
