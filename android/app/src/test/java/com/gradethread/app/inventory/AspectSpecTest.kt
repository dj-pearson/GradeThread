package com.gradethread.app.inventory

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1347: the category aspect spec — the doubly-nested envelope, the closed
 * lists, and the order that decides whether a seller sees the blockers.
 */
class AspectSpecTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun aspect(
        name: String,
        required: Boolean = false,
        usage: String? = null,
        mode: String? = null,
        cardinality: String? = null,
        values: List<String> = emptyList(),
    ) = EbayAspect(
        localizedAspectName = name,
        aspectConstraint = AspectConstraint(
            aspectMode = mode,
            aspectRequired = required,
            aspectUsage = usage,
            itemToAspectCardinality = cardinality,
        ),
        aspectValues = values.map { AspectValueOption(it) },
    )

    @Test
    fun `the doubly-nested envelope unwraps exactly once`() {
        // The edge passes eBay's own envelope through, so the payload really is
        // `{ aspects: { aspects: [...] } }`. Modelled as it arrives.
        val decoded = json.decodeFromString(
            AspectSpecResponse.serializer(),
            """{"aspects":{"aspects":[
                {"localizedAspectName":"Brand","aspectConstraint":{"aspectRequired":true}},
                {"localizedAspectName":"  ","aspectConstraint":{}}
              ]},"categoryName":"Men's Sweaters","cached":true}""",
        )
        // The nameless entry is dropped rather than rendered as a blank row.
        assertEquals(listOf("Brand"), decoded.aspectList.map { it.name })
        assertEquals("Men's Sweaters", decoded.categoryName)
        assertTrue(decoded.cached)
    }

    @Test
    fun `an empty or malformed spec decodes to no aspects`() {
        val empty = json.decodeFromString(AspectSpecResponse.serializer(), """{"aspects":{}}""")
        assertTrue(empty.aspectList.isEmpty())
    }

    @Test
    fun `required aspects come first so the blockers are visible`() {
        // Alphabetical alone buries the two that block a publish among forty
        // optional ones — which is how an item reaches publish missing one.
        val ordered = AspectSpecs.ordered(
            listOf(
                aspect("Zebra"),
                aspect("Colour", usage = "RECOMMENDED"),
                aspect("Size", required = true),
                aspect("Alpha"),
                aspect("Brand", required = true),
            ),
        )
        assertEquals(
            listOf("Brand", "Size", "Colour", "Alpha", "Zebra"),
            ordered.map { it.name },
        )
    }

    @Test
    fun `required names feed the publish-blocker check`() {
        val required = AspectSpecs.requiredNames(
            listOf(aspect("Brand", required = true), aspect("Style")),
        )
        assertEquals(listOf("Brand"), required)
        assertEquals(
            listOf("Brand"),
            AspectSync.requiredMissing(required, emptyMap()),
        )
        assertTrue(
            AspectSync.requiredMissing(required, mapOf("Brand" to listOf("Patagonia"))).isEmpty(),
        )
    }

    // ── closed lists ─────────────────────────────────────────────────────

    @Test
    fun `only SELECTION_ONLY is a closed list`() {
        // FREE_TEXT aspects still carry suggested values; treating those as
        // closed would block a legitimate value eBay would have accepted.
        val closed = aspect("Department", mode = "SELECTION_ONLY", values = listOf("Men", "Women"))
        val free = aspect("Style", mode = "FREE_TEXT", values = listOf("Pullover"))
        assertTrue(closed.selectionOnly)
        assertFalse(free.selectionOnly)
        assertEquals("Anything At All", AspectSpecs.normalize(free, " Anything At All "))
    }

    @Test
    fun `a closed list matches case-insensitively and refuses the rest`() {
        val closed = aspect("Department", mode = "SELECTION_ONLY", values = listOf("Men", "Women"))
        assertEquals("Men", AspectSpecs.normalize(closed, "men"))
        assertEquals("Women", AspectSpecs.normalize(closed, "  WOMEN "))
        // Refused in the editor beats eBay rejecting the whole publish for one
        // unrecognised specific.
        assertNull(AspectSpecs.normalize(closed, "Unisex"))
        assertNull(AspectSpecs.normalize(closed, "   "))
    }

    @Test
    fun `a closed list with no options accepts nothing`() {
        val broken = aspect("Department", mode = "SELECTION_ONLY")
        assertNull(AspectSpecs.normalize(broken, "Men"))
    }

    @Test
    fun `cardinality drives single versus multi select`() {
        assertTrue(aspect("Features", cardinality = "MULTI").multiValued)
        assertFalse(aspect("Brand", cardinality = "SINGLE").multiValued)
        assertFalse(aspect("Brand").multiValued)
    }

    @Test
    fun `blank allowed values are dropped`() {
        val spec = aspect("Size", mode = "SELECTION_ONLY", values = listOf("M", "  ", "L"))
        assertEquals(listOf("M", "L"), spec.allowedValues)
    }
}
