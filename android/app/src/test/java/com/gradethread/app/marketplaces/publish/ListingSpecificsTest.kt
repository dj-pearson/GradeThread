package com.gradethread.app.marketplaces.publish

import com.gradethread.app.inventory.AspectConstraint
import com.gradethread.app.inventory.AspectValueOption
import com.gradethread.app.inventory.EbayAspect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1353: listing-time specifics.
 *
 * Two rules carry real risk. Saying a required aspect is handled when the
 * server won't actually fill it means a publish that fails after the seller
 * commits; and sending a value a closed-list aspect doesn't allow makes eBay
 * reject the whole listing over one specific.
 */
class ListingSpecificsTest {

    private fun aspect(
        name: String,
        required: Boolean = false,
        multi: Boolean = false,
        selectionOnly: Boolean = false,
        values: List<String> = emptyList(),
    ) = EbayAspect(
        localizedAspectName = name,
        aspectConstraint = AspectConstraint(
            aspectMode = if (selectionOnly) "SELECTION_ONLY" else "FREE_TEXT",
            aspectRequired = required,
            itemToAspectCardinality = if (multi) "MULTI" else "SINGLE",
        ),
        aspectValues = values.map { AspectValueOption(it) },
    )

    // ── measurement auto-fill (resolveMeasurementAspects parity) ─────────────

    @Test
    fun `a free-text measurement aspect is filled from the item's measurements`() {
        val derived = ListingSpecifics.measurementAspects(
            aspects = listOf(aspect("Chest Size"), aspect("Sleeve Length")),
            measurements = mapOf("chest" to 21.0, "sleeve" to 25.5),
            existing = emptyMap(),
        )
        assertEquals(mapOf("Chest Size" to "21 in", "Sleeve Length" to "25.5 in"), derived)
    }

    @Test
    fun `an aspect with a closed list is never auto-filled`() {
        // The server only fills aspects with no allowed values — a closed list
        // would reject a free-form "21 in", so claiming it was handled would be
        // a publish failure waiting to happen.
        val derived = ListingSpecifics.measurementAspects(
            aspects = listOf(
                aspect("Chest Size", selectionOnly = true, values = listOf("S", "M", "L")),
            ),
            measurements = mapOf("chest" to 21.0),
            existing = emptyMap(),
        )
        assertTrue(derived.isEmpty())
    }

    @Test
    fun `a value the seller already set wins over the derived one`() {
        val derived = ListingSpecifics.measurementAspects(
            aspects = listOf(aspect("Chest Size")),
            measurements = mapOf("chest" to 21.0),
            existing = mapOf("chest size" to listOf("Oversized")),
        )
        assertTrue("case-insensitive match, like the edge", derived.isEmpty())
    }

    @Test
    fun `only the first matching candidate name is used`() {
        // chest → "Chest Size", "Chest", "Pit to Pit". One measurement fills one
        // aspect; filling all three would publish the same number three times.
        val derived = ListingSpecifics.measurementAspects(
            aspects = listOf(aspect("Chest"), aspect("Chest Size"), aspect("Pit to Pit")),
            measurements = mapOf("chest" to 21.0),
            existing = emptyMap(),
        )
        assertEquals(mapOf("Chest Size" to "21 in"), derived)
    }

    @Test
    fun `shoe and watch measurements carry their own units`() {
        val derived = ListingSpecifics.measurementAspects(
            aspects = listOf(aspect("US Shoe Size"), aspect("Case Diameter")),
            measurements = mapOf("size_us" to 10.0, "case_diameter" to 42.0),
            existing = emptyMap(),
        )
        assertEquals(mapOf("US Shoe Size" to "US 10", "Case Diameter" to "42 mm"), derived)
    }

    // ── required-aspect blockers ─────────────────────────────────────────────

    @Test
    fun `an empty required aspect blocks the publish`() {
        val missing = ListingSpecifics.missingRequired(
            aspects = listOf(aspect("Department", required = true), aspect("Style")),
            values = emptyMap(),
        )
        assertEquals(listOf("Department"), missing)
        assertEquals(
            listOf("Department is required for this eBay category."),
            ListingSpecifics.blockers(missing),
        )
    }

    @Test
    fun `a required aspect the publish will auto-fill is not a blocker`() {
        val missing = ListingSpecifics.missingRequired(
            aspects = listOf(aspect("Chest Size", required = true)),
            values = emptyMap(),
            measurements = mapOf("chest" to 21.0),
        )
        assertTrue("chest is measured, so the server fills it", missing.isEmpty())
    }

    @Test
    fun `a blank value does not count as filled`() {
        val missing = ListingSpecifics.missingRequired(
            aspects = listOf(aspect("Department", required = true)),
            values = mapOf("Department" to listOf("   ")),
        )
        assertEquals(listOf("Department"), missing)
    }

    @Test
    fun `optional aspects never block`() {
        val missing = ListingSpecifics.missingRequired(
            aspects = listOf(aspect("Style"), aspect("Pattern")),
            values = emptyMap(),
        )
        assertTrue(missing.isEmpty())
    }

    // ── editing ──────────────────────────────────────────────────────────────

    @Test
    fun `a value outside a closed list is dropped, not sent`() {
        val closed = aspect("Department", selectionOnly = true, values = listOf("Men", "Women"))
        val values = ListingSpecifics.set(emptyMap(), closed, listOf("Unisex"))
        assertTrue("eBay would reject the whole listing over it", values.isEmpty())
    }

    @Test
    fun `a closed-list value is matched case-insensitively and stored canonically`() {
        val closed = aspect("Department", selectionOnly = true, values = listOf("Men", "Women"))
        val values = ListingSpecifics.set(emptyMap(), closed, listOf("men"))
        assertEquals(listOf("Men"), values["Department"])
    }

    @Test
    fun `a single-valued aspect keeps one value`() {
        val single = aspect("Style")
        val values = ListingSpecifics.set(emptyMap(), single, listOf("Bomber", "Varsity"))
        assertEquals(listOf("Bomber"), values["Style"])
    }

    @Test
    fun `a multi-valued aspect keeps them all, deduped`() {
        val multi = aspect("Features", multi = true)
        val values = ListingSpecifics.set(emptyMap(), multi, listOf("Pockets", "Lined", "Pockets"))
        assertEquals(listOf("Pockets", "Lined"), values["Features"])
    }

    @Test
    fun `clearing an aspect removes it rather than storing an empty list`() {
        val single = aspect("Style")
        val values = ListingSpecifics.set(mapOf("Style" to listOf("Bomber")), single, listOf(""))
        assertFalse(values.containsKey("Style"))
    }

    @Test
    fun `required aspects sort ahead of the rest in the editor`() {
        val fields = ListingSpecifics.fields(
            aspects = listOf(aspect("Zebra"), aspect("Department", required = true)),
            values = emptyMap(),
        )
        assertEquals(listOf("Department", "Zebra"), fields.map { it.name })
        assertTrue(fields.first().blocking)
    }
}
