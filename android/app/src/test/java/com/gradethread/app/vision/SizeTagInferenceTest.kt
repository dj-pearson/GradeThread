package com.gradethread.app.vision

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1333: the tag-inference rule set, ported case-for-case from the iOS
 * `SizeTagInferenceTests` so the two platforms cannot drift.
 *
 * These tests ARE the spec — the parsing is deliberately narrow and every
 * bound here encodes a false positive someone actually hit.
 */
class SizeTagInferenceTest {

    // ── brand ────────────────────────────────────────────────────────────

    @Test
    fun brandFromWhitelistIsTitleCased() {
        assertEquals("Patagonia", SizeTagInference.detectBrand(listOf("PATAGONIA")))
    }

    @Test
    fun brandMatchesRegardlessOfCase() {
        assertEquals("Adidas", SizeTagInference.detectBrand(listOf("adidas")))
    }

    @Test
    fun brandMatchesInsideANoisyLine() {
        assertEquals("Patagonia", SizeTagInference.detectBrand(listOf("PATAGONIA INC")))
    }

    @Test
    fun multiWordBrandMatchesAcrossOcrLineSplits() {
        // OCR routinely breaks a wide logo into two lines.
        assertEquals(
            "The North Face",
            SizeTagInference.detectBrand(listOf("THE NORTH", "FACE")),
        )
    }

    @Test
    fun longestMatchWins() {
        // "north face" is also in the whitelist; without the longest-match
        // tiebreak the answer would depend on set iteration order.
        assertEquals(
            "The North Face",
            SizeTagInference.detectBrand(listOf("THE NORTH FACE")),
        )
    }

    @Test
    fun styleNamesAreNotBrands() {
        // The reason there is no "prominent uppercase line" heuristic.
        assertNull(SizeTagInference.detectBrand(listOf("SYNCHILLA")))
        assertNull(SizeTagInference.detectBrand(listOf("HERITAGE")))
        assertNull(SizeTagInference.detectBrand(listOf("VINTAGE")))
    }

    @Test
    fun sizeLinesAreNotBrands() {
        assertNull(SizeTagInference.detectBrand(listOf("SIZE M", "XL")))
    }

    @Test
    fun wordBoundary_fleeceIsNotLee() {
        // Substring matching would read "lee" out of "FLEECE".
        assertNull(SizeTagInference.detectBrand(listOf("POLARTEC FLEECE")))
    }

    @Test
    fun wordBoundary_supremelyIsNotSupreme() {
        assertNull(SizeTagInference.detectBrand(listOf("Supremely soft cotton")))
    }

    @Test
    fun wordBoundary_gapsIsNotGap() {
        assertNull(SizeTagInference.detectBrand(listOf("mind the gaps")))
    }

    @Test
    fun wordBoundary_standaloneLeeStillMatches() {
        // The boundary rule must not cost us the true positive.
        assertEquals("Lee", SizeTagInference.detectBrand(listOf("LEE RIDERS")))
    }

    @Test
    fun punctuatedBrandsMatchLiterally() {
        assertEquals("Levi's", SizeTagInference.detectBrand(listOf("LEVI'S")))
    }

    @Test
    fun noWhitelistHitReturnsNothing() {
        // Return nothing rather than guess.
        assertNull(SizeTagInference.detectBrand(listOf("ACME APPAREL CO")))
    }

    // ── size ─────────────────────────────────────────────────────────────

    @Test
    fun bareAlphaSize() {
        assertEquals("M", SizeTagInference.detectSize(listOf("M")))
    }

    @Test
    fun bareAlphaSize_xxxl() {
        assertEquals("XXXL", SizeTagInference.detectSize(listOf("XXXL")))
    }

    @Test
    fun alphaSizeIsNotMatchedAsASubstring() {
        // "MADE IN MALAYSIA" must not yield "M".
        assertNull(SizeTagInference.detectSize(listOf("MADE IN MALAYSIA")))
    }

    @Test
    fun waistLength_withWAndLPrefixes() {
        assertEquals("34x32", SizeTagInference.detectSize(listOf("W34 L32")))
    }

    @Test
    fun waistLength_withSpacedX() {
        assertEquals("30x30", SizeTagInference.detectSize(listOf("30 x 30")))
    }

    @Test
    fun waistLength_normalizesToLowercaseXNoSpaces() {
        assertEquals("32x34", SizeTagInference.detectSize(listOf("32 X 34")))
    }

    @Test
    fun waistLength_rejectsImplausibleMeasurements() {
        // 10 is not a waist; this is a style number, not a size.
        assertNull(SizeTagInference.detectSize(listOf("10x20")))
    }

    @Test
    fun explicitSize_numeric() {
        assertEquals("12", SizeTagInference.detectSize(listOf("Size 12")))
    }

    @Test
    fun explicitSize_alphaWithColon() {
        assertEquals("M", SizeTagInference.detectSize(listOf("Size: M")))
    }

    @Test
    fun bareNumericSize() {
        assertEquals("10", SizeTagInference.detectSize(listOf("10")))
    }

    @Test
    fun bareNumericSize_normalizesLeadingZeros() {
        assertEquals("7", SizeTagInference.detectSize(listOf("007")))
    }

    @Test
    fun rejectsAYear() {
        // 2024 is above the 54 cap precisely so this can't happen.
        assertNull(SizeTagInference.detectSize(listOf("2024")))
    }

    @Test
    fun rejectsBareZero() {
        assertNull(SizeTagInference.detectSize(listOf("0")))
    }

    @Test
    fun rejectsExplicitSizeZero() {
        // A "0" after "Size" is far more often a care-symbol code or noise.
        assertNull(SizeTagInference.detectSize(listOf("Size 0")))
    }

    @Test
    fun rejectsBareNumericAboveTheCap() {
        assertNull(SizeTagInference.detectSize(listOf("55")))
    }

    @Test
    fun acceptsBareNumericBounds() {
        assertEquals("1", SizeTagInference.detectSize(listOf("1")))
        assertEquals("54", SizeTagInference.detectSize(listOf("54")))
    }

    @Test
    fun explicitSizeBoundIsWiderThanBareNumeric() {
        // 60 is accepted with a "Size" prefix vouching for it, rejected bare.
        assertEquals("60", SizeTagInference.detectSize(listOf("Size 60")))
        assertNull(SizeTagInference.detectSize(listOf("60")))
    }

    @Test
    fun precedence_waistLengthBeatsAlphaEarlierInTheList() {
        // Each pass scans ALL lines before the next begins, so the more
        // specific measurement wins even though "M" appears first.
        assertEquals(
            "32x30",
            SizeTagInference.detectSize(listOf("LEVI'S", "M", "32 x 30")),
        )
    }

    @Test
    fun precedence_explicitBeatsBareNumeric() {
        assertEquals("8", SizeTagInference.detectSize(listOf("40", "Size 8")))
    }

    @Test
    fun emptyInputYieldsNothing() {
        assertNull(SizeTagInference.detectSize(emptyList()))
        assertNull(SizeTagInference.detectBrand(emptyList()))
    }

    // ── the fill-blanks gate ─────────────────────────────────────────────

    @Test
    fun inferFillsBothWhenBothAreMissing() {
        val result = SizeTagInference.infer(listOf("PATAGONIA", "M"))
        assertEquals("Patagonia", result.brand)
        assertEquals("M", result.size)
    }

    @Test
    fun inferNeverRecomputesAFieldThatAlreadyHasAValue() {
        // The whole safety property: a Claude- or seller-provided value can
        // never be overwritten by a weaker OCR guess, because it is never
        // even computed.
        val result = SizeTagInference.infer(
            lines = listOf("PATAGONIA", "M"),
            existingBrand = "Arc'teryx",
            existingSize = null,
        )
        assertNull(result.brand)
        assertEquals("M", result.size)
    }

    @Test
    fun blankExistingValuesCountAsMissing() {
        val result = SizeTagInference.infer(
            lines = listOf("PATAGONIA"),
            existingBrand = "   ",
        )
        assertEquals("Patagonia", result.brand)
    }

    @Test
    fun inferIsEmptyWhenTheTagYieldsNothing() {
        assertTrue(SizeTagInference.infer(listOf("MADE IN VIETNAM")).isEmpty)
    }

    @Test
    fun needsInferenceGatesTheWholeOcrPass() {
        assertFalse(SizeTagInference.needsInference("Patagonia", "M"))
        assertTrue(SizeTagInference.needsInference("Patagonia", null))
        assertTrue(SizeTagInference.needsInference(null, "M"))
        assertTrue(SizeTagInference.needsInference("", ""))
    }

    @Test
    fun suggestionConfidenceStaysBelowTheAutoApplyBar() {
        // Lockstep with the iOS autoApplyConfidenceThreshold of 0.5. If this
        // ever rises above the bar, OCR guesses start silently auto-filling
        // the form, which is exactly what the 0.4 stamp exists to prevent.
        assertTrue(SizeTagInference.SUGGESTION_CONFIDENCE < 0.5)
    }
}
