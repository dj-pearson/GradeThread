package com.gradethread.app.inventory

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2921: the size-versus-measurements check, run against the SAME two fixture
 * cases as `services/edge-functions/src/tests/size-check_test.ts`,
 * `src/lib/size-check.test.ts` and `ios/GradeThreadTests/SizeCheckTests.swift`.
 * Four copies of one rule only stay one rule if they answer the same questions
 * with the same numbers.
 *
 * THE MOTIVATING CASE. A Lululemon men's top measuring 17.5 in pit to pit,
 * labelled Large. The brand's own chart puts a Large at a 41-43 in body chest,
 * which is a 22-26.5 in flat garment. 17.5 is below the smallest size they make,
 * so the check must fire and say so.
 *
 * THE NO-FALSE-ALARM CASE. An ordinary men's tee measuring 22 in pit to pit,
 * labelled L, on the generic chart. A generic Large is exactly 22-26.5 in flat,
 * so the check must stay quiet. This is the case that keeps the feature usable:
 * a checker that cries wolf on correctly sized items gets switched off, and then
 * it catches nothing at all.
 */
class SizeCheckTest {

    private fun row(size: String, index: Int, chest: List<Double>) =
        SizeCheck.BandRow(size = size, index = index, bands = mapOf("chest" to chest))

    /** What GET /api/flipdesk/size-bands returns for Lululemon men's tops. */
    private val lululemonMensTops = listOf(
        row("XS", 0, listOf(18.0, 22.5)),
        row("S", 1, listOf(19.0, 23.5)),
        row("M", 2, listOf(20.5, 25.0)),
        row("L", 3, listOf(22.0, 26.5)),
        row("XL", 4, listOf(23.5, 28.0)),
        row("XXL", 5, listOf(25.0, 29.5)),
    )

    /** The generic men's alpha fallback, used when a brand has no chart. */
    private val genericMensTops = listOf(
        row("S", 0, listOf(19.0, 23.5)),
        row("M", 1, listOf(20.5, 25.0)),
        row("L", 2, listOf(22.0, 26.5)),
        row("XL", 3, listOf(23.5, 28.0)),
        row("XXL", 4, listOf(25.0, 29.5)),
    )

    // ── The two fixture cases ───────────────────────────────────────────────

    @Test
    fun `motivating case - 17_5 inch chest labelled Large fires`() {
        assertEquals(3, SizeCheck.resolveRow(lululemonMensTops, "Large"))
        val verdict = SizeCheck.check(
            rows = lululemonMensTops,
            rowIndex = 3,
            measurements = mapOf("chest" to 17.5),
            tier = "brand",
        )
        assertEquals(SizeCheck.Status.OFF, verdict.status)
        assertTrue("stepsOff was ${verdict.stepsOff}", verdict.stepsOff >= 2)
        assertEquals("smaller than XS", verdict.impliedSize)
        assertEquals("chest", verdict.key)
        assertEquals(listOf(22.0, 26.5), verdict.expected)
    }

    @Test
    fun `no false alarm - a real 22 inch Large tee stays quiet`() {
        assertEquals(2, SizeCheck.resolveRow(genericMensTops, "L"))
        val verdict = SizeCheck.check(
            rows = genericMensTops,
            rowIndex = 2,
            measurements = mapOf("chest" to 22.0),
            tier = "generic",
        )
        assertEquals(SizeCheck.Status.OK, verdict.status)
        assertEquals(0, verdict.stepsOff)
    }

    // ── Tolerance ───────────────────────────────────────────────────────────

    @Test
    fun `tolerance is one step on a real chart and two on a generic one`() {
        assertEquals(1, SizeCheck.toleranceForTier("verified"))
        assertEquals(1, SizeCheck.toleranceForTier("brand"))
        assertEquals(2, SizeCheck.toleranceForTier("generic"))
    }

    @Test
    fun `a one step disagreement fires on a brand chart and not a generic one`() {
        val onBrand = SizeCheck.check(
            rows = genericMensTops,
            rowIndex = 2,
            measurements = mapOf("chest" to 20.5),
            tier = "brand",
        )
        assertEquals(1, onBrand.stepsOff)
        assertEquals(SizeCheck.Status.OFF, onBrand.status)

        val onGeneric = SizeCheck.check(
            rows = genericMensTops,
            rowIndex = 2,
            measurements = mapOf("chest" to 20.5),
            tier = "generic",
        )
        assertEquals(SizeCheck.Status.OK, onGeneric.status)
    }

    // ── Label matching ──────────────────────────────────────────────────────

    @Test
    fun `size labels resolve across the spellings sellers actually use`() {
        assertEquals(3, SizeCheck.resolveRow(lululemonMensTops, "Large"))
        assertEquals(3, SizeCheck.resolveRow(lululemonMensTops, "l"))
        assertEquals(3, SizeCheck.resolveRow(lululemonMensTops, "  L  "))
        assertEquals(5, SizeCheck.resolveRow(lululemonMensTops, "2XL"))
        assertEquals(5, SizeCheck.resolveRow(lululemonMensTops, "XXL"))
        assertEquals(0, SizeCheck.resolveRow(lululemonMensTops, "extra small"))
    }

    @Test
    fun `no match is null, never row zero`() {
        assertNull(SizeCheck.resolveRow(lululemonMensTops, "42R"))
        assertNull(SizeCheck.resolveRow(lululemonMensTops, ""))
        assertNull(SizeCheck.resolveRow(lululemonMensTops, null))
    }

    @Test
    fun `a bare twelve is not a UK twelve`() {
        val uk = listOf(
            SizeCheck.BandRow("UK 10 / S", 0, mapOf("waist" to listOf(14.0, 16.0))),
            SizeCheck.BandRow("UK 12 / M", 1, mapOf("waist" to listOf(15.0, 17.0))),
        )
        assertEquals(1, SizeCheck.resolveRow(uk, "M"))
        assertEquals(1, SizeCheck.resolveRow(uk, "UK 12"))
        // The corpus warns that assuming a bare 12 is a UK 12 is the costliest
        // mistake on these brands.
        assertNull(SizeCheck.resolveRow(uk, "12"))
    }

    // ── Silence ─────────────────────────────────────────────────────────────

    @Test
    fun `unknown when nothing can be judged`() {
        assertEquals(
            SizeCheck.Status.UNKNOWN,
            SizeCheck.check(genericMensTops, null, mapOf("chest" to 21.0), "brand").status,
        )
        assertEquals(
            SizeCheck.Status.UNKNOWN,
            SizeCheck.check(genericMensTops, 2, emptyMap(), "brand").status,
        )
        assertEquals(
            SizeCheck.Status.UNKNOWN,
            SizeCheck.check(genericMensTops, 2, mapOf("chest" to 21.0), "none").status,
        )
        assertEquals(
            SizeCheck.Status.UNKNOWN,
            SizeCheck.check(emptyList(), 0, mapOf("chest" to 21.0), "brand").status,
        )
    }

    // ── The one-click fix ───────────────────────────────────────────────────

    @Test
    fun `no one click fix for a size the brand does not make`() {
        val verdict = SizeCheck.check(
            rows = lululemonMensTops,
            rowIndex = 3,
            measurements = mapOf("chest" to 17.5),
            tier = "brand",
        )
        assertNull(SizeCheck.fixableSize(verdict))
    }

    @Test
    fun `the fix offers the implied size when the brand makes it`() {
        val verdict = SizeCheck.check(
            rows = lululemonMensTops,
            rowIndex = 5,
            measurements = mapOf("chest" to 22.5),
            tier = "brand",
        )
        assertEquals(SizeCheck.Status.OFF, verdict.status)
        assertEquals(verdict.impliedSize, SizeCheck.fixableSize(verdict))
    }

    // ── Department ──────────────────────────────────────────────────────────

    @Test
    fun `department reads men and women and refuses everything else`() {
        assertEquals("Men", SizeCheck.departmentFromText(listOf("Nike Mens Tee")))
        assertEquals("Women", SizeCheck.departmentFromText(listOf("Womens Blouse")))
        // "women" contains "men"; women must win.
        assertEquals("Women", SizeCheck.departmentFromText(listOf("Lululemon women's top")))
        assertNull(SizeCheck.departmentFromText(listOf("Plain cotton tee")))
        assertNull(SizeCheck.departmentFromText(listOf("Boys size 10 hoodie")))
        assertNull(SizeCheck.departmentFromText(listOf(null)))
    }

    // ── Decoding the endpoint's response ────────────────────────────────────

    @Test
    fun `decodes the band table the edge returns`() {
        val raw = """
            {"tier":"brand","brandLabel":"Lululemon","department":"Men","garment":"Tops",
             "sourceUrl":null,"sizeSystem":"alpha","sizeClass":"standard",
             "measurementBasis":"body",
             "rows":[{"size":"XS","index":0,"bands":{"chest":[18,22.5]}}]}
        """.trimIndent()
        val json = Json { ignoreUnknownKeys = true; isLenient = true }
        val response = json.decodeFromString(SizeCheck.BandsResponse.serializer(), raw)
        assertEquals("brand", response.tier)
        assertEquals("Lululemon", response.brandLabel)
        assertEquals("body", response.measurementBasis)
        assertEquals(listOf(18.0, 22.5), response.rows.first().bands["chest"])
    }
}
