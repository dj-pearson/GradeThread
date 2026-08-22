package com.gradethread.app.inventory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * US-1345: measurements — the jsonb round trip, the locale trap, and what the
 * size estimate is allowed to do.
 */
class MeasurementCatalogTest {

    // ── the locale trap (iOS US-1491) ────────────────────────────────────

    @Test
    fun `a comma-decimal locale round-trips its own separator`() {
        // iOS shipped a raw Double(text) parse that returned null for "18,5" in
        // de/fr/es, and a "."-formatted display that re-parsed as GROUPING —
        // so 18.5 came back as 185.
        val de = Locale.GERMANY
        assertEquals("18,5", MeasurementCatalog.editableString(18.5, de))
        assertEquals(18.5, MeasurementCatalog.parse("18,5", de)!!, 1e-9)
        // And the round trip closes.
        assertEquals(
            18.5,
            MeasurementCatalog.parse(MeasurementCatalog.editableString(18.5, de), de)!!,
            1e-9,
        )
    }

    @Test
    fun `grouping separators are never emitted`() {
        // "1.250" in a dot-grouping locale re-parses as 1.25 or 1250 depending
        // on who reads it. Never producing one avoids the question.
        assertEquals("1250", MeasurementCatalog.editableString(1250.0, Locale.US))
        assertEquals("1250", MeasurementCatalog.editableString(1250.0, Locale.GERMANY))
    }

    @Test
    fun `US locale still behaves`() {
        assertEquals("18.5", MeasurementCatalog.editableString(18.5, Locale.US))
        assertEquals(18.5, MeasurementCatalog.parse("18.5", Locale.US)!!, 1e-9)
        assertEquals("20", MeasurementCatalog.editableString(20.0, Locale.US))
    }

    @Test
    fun `unset and nonsense values yield no text and no number`() {
        assertEquals("", MeasurementCatalog.editableString(null))
        assertEquals("", MeasurementCatalog.editableString(0.0))
        assertEquals("", MeasurementCatalog.editableString(-4.0))
        assertNull(MeasurementCatalog.parse("", Locale.US))
        assertNull(MeasurementCatalog.parse("   ", Locale.US))
        assertNull(MeasurementCatalog.parse("about twenty", Locale.US))
        // Zero is not a measurement — a listing claiming a 0" chest is worse
        // than one claiming nothing.
        assertNull(MeasurementCatalog.parse("0", Locale.US))
        assertNull(MeasurementCatalog.parse("-3", Locale.US))
    }

    // ── the jsonb round trip ─────────────────────────────────────────────

    @Test
    fun `decode keeps only positive numbers`() {
        val decoded = MeasurementCatalog.decode(
            """{"chest":21.5,"waist":0,"sleeve":-2,"length":29}""",
        )
        assertEquals(mapOf("chest" to 21.5, "length" to 29.0), decoded)
    }

    @Test
    fun `a malformed document degrades to empty rather than crashing`() {
        assertEquals(emptyMap<String, Double>(), MeasurementCatalog.decode("not json"))
        assertEquals(emptyMap<String, Double>(), MeasurementCatalog.decode(null))
        assertEquals(emptyMap<String, Double>(), MeasurementCatalog.decode(""))
        assertEquals(emptyMap<String, Double>(), MeasurementCatalog.decode("[1,2,3]"))
    }

    @Test
    fun `encode emits canonical order and drops empties`() {
        val encoded = MeasurementCatalog.encode(
            mapOf("length" to 29.0, "chest" to 21.5, "bogus" to 0.0),
        )
        // Catalog order (chest before length), not insertion order.
        assertEquals("""{"chest":21.5,"length":29.0}""", encoded)
    }

    @Test
    fun `an empty measurement set encodes to null, not an empty object`() {
        // "{}" is a document; null is the absence of one. The column should
        // read as unset, not as "measured, and the answer was nothing".
        assertNull(MeasurementCatalog.encode(emptyMap()))
        assertNull(MeasurementCatalog.encode(mapOf("chest" to 0.0)))
    }

    @Test
    fun `a full round trip preserves the values`() {
        val original = mapOf("chest" to 21.5, "sleeve" to 25.0)
        assertEquals(original, MeasurementCatalog.decode(MeasurementCatalog.encode(original)))
    }

    // ── catalog behaviour ────────────────────────────────────────────────

    @Test
    fun `suggested keys follow the item category`() {
        assertEquals(listOf("size_us", "insole"), MeasurementCatalog.suggestedKeys("shoes"))
        assertEquals(
            listOf("case_diameter", "lug_width", "band_length"),
            MeasurementCatalog.suggestedKeys("watches"),
        )
        // Clothing and anything uncategorised get the garment set.
        assertTrue(MeasurementCatalog.suggestedKeys(null).contains("chest"))
        assertTrue(MeasurementCatalog.suggestedKeys("clothing").contains("inseam"))
    }

    @Test
    fun `unknown keys are labelled and treated as lengths, never dropped`() {
        // The server can add a key before this client knows it; hiding the
        // value would look like data loss.
        assertEquals("Pit To Cuff", MeasurementCatalog.label("pit_to_cuff"))
        assertEquals(MeasurementCatalog.Kind.LENGTH, MeasurementCatalog.kind("pit_to_cuff"))
        assertEquals(
            listOf("chest", "length", "aaa_custom", "pit_to_cuff"),
            MeasurementCatalog.ordered(listOf("pit_to_cuff", "length", "aaa_custom", "chest")),
        )
    }

    @Test
    fun `units are attached to the right kinds`() {
        assertEquals("in", MeasurementCatalog.kind("chest").unit)
        assertEquals("US", MeasurementCatalog.kind("size_us").unit)
        assertEquals("mm", MeasurementCatalog.kind("case_diameter").unit)
    }

    // ── the size estimate (AC2, as the endpoint actually behaves) ────────

    @Test
    fun `an empty size is not offered as a suggestion`() {
        // "" is a real answer meaning "I can't tell". Applying it would CLEAR a
        // size the seller had already read off the tag.
        assertFalse(SizeEstimate(size = "", confidence = 0.9).isUsable)
        assertFalse(SizeEstimate(size = "   ", confidence = 0.9).isUsable)
        assertTrue(SizeEstimate(size = "M", confidence = 0.4).isUsable)
    }

    @Test
    fun `low confidence comes from the server, not a local threshold`() {
        // One place decides what "low" means; re-deriving it here would drift
        // the moment the server tunes it.
        val flagged = SizeEstimate(size = "M", confidence = 0.9, lowConfidence = true)
        assertTrue(flagged.lowConfidence)
        assertEquals(90, flagged.confidencePercent)
    }

    @Test
    fun `a nonsense confidence cannot render outside 0-100`() {
        assertEquals(100, SizeEstimate(size = "M", confidence = 4.0).confidencePercent)
        assertEquals(0, SizeEstimate(size = "M", confidence = -1.0).confidencePercent)
    }

    // ── US-1353: the published form of a measurement ─────────────────────────

    @Test
    fun `publishValue formats the way the marketplace sees it`() {
        assertEquals("21 in", MeasurementCatalog.publishValue("chest", 21.0))
        assertEquals("25.5 in", MeasurementCatalog.publishValue("sleeve", 25.5))
        assertEquals("US 10", MeasurementCatalog.publishValue("size_us", 10.0))
        assertEquals("42 mm", MeasurementCatalog.publishValue("case_diameter", 42.0))
    }

    @Test
    fun `publishValue never uses the device's decimal separator`() {
        // The editing formatter is locale-aware on purpose; this one must not
        // be. "20,5 in" is not what the server would publish, and showing it
        // would misreport the listing.
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            assertEquals("20.5 in", MeasurementCatalog.publishValue("chest", 20.5))
        } finally {
            Locale.setDefault(previous)
        }
    }

    @Test
    fun `a non-positive measurement has no published form`() {
        assertNull(MeasurementCatalog.publishValue("chest", 0.0))
        assertNull(MeasurementCatalog.publishValue("chest", -3.0))
    }

    /**
     * US-2812: keys that are COLLECTED but map to no eBay aspect.
     *
     * Shrink-only, and every entry is here because the WEB has the same gap —
     * `MEASUREMENT_SPECS` in src/lib/measurements.ts covers the same sixteen
     * keys this catalog used to, and none of these eight. They live in
     * MEASUREMENT_TEMPLATES, which is the form, not the aspect map.
     *
     * They were added here so a bag's depth and a belt's hole span can be
     * MEASURED on iOS and Android at all — the web has asked for them since
     * US-2224/US-2225 and the native catalogs never learned them. Mapping them
     * to eBay aspects is separate work needing real category data (what does
     * eBay call a hat's inside circumference?), and guessing a name here would
     * put an invented aspect on a live listing.
     */
    private val NO_ASPECT_YET = setOf(
        "height", "depth", "strap_drop", "handle_drop",
        "hole_span", "circumference", "crown_height", "brim_length",
    )

    @Test
    fun `every measurement key offers at least one aspect candidate`() {
        // A key with no candidates silently never auto-fills at publish.
        val missing = MeasurementCatalog.specs
            .map { it.key }
            .filter { MeasurementCatalog.aspectCandidates[it].isNullOrEmpty() }
            .filter { it !in NO_ASPECT_YET }
        assertEquals(emptyList<String>(), missing)
    }

    @Test
    fun `the no-aspect exemption list can only shrink`() {
        // An entry that starts resolving must be REMOVED, so the list cannot
        // quietly become the place unmapped keys go to be forgotten.
        val nowMapped = NO_ASPECT_YET
            .filter { !MeasurementCatalog.aspectCandidates[it].isNullOrEmpty() }
        assertEquals(emptyList<String>(), nowMapped)
    }
}
