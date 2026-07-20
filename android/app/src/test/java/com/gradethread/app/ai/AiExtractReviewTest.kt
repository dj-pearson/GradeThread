package com.gradethread.app.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1334: the tiering, conflict and feedback rules.
 *
 * These encode the trust model — what gets written without asking, what
 * requires an explicit tick, and what the AI is told about its own mistakes.
 */
class AiExtractReviewTest {

    private fun s(value: String, confidence: Double, source: String = "photo:front") =
        FieldSuggestion(value, confidence, source)

    // ── the auto-apply bar ───────────────────────────────────────────────

    @Test
    fun atOrAboveTheBarIsAutoApplied() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("brand" to s("Patagonia", 0.9))),
        )
        assertEquals(listOf("brand"), review.applied.map { it.field })
        assertTrue(review.lowConfidence.isEmpty())
    }

    @Test
    fun exactlyAtTheBarIsInclusive() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("brand" to s("Nike", 0.5))),
        )
        assertEquals(1, review.applied.size)
    }

    @Test
    fun belowTheBarRequiresOptIn() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("brand" to s("Nike", 0.49))),
        )
        assertTrue(review.applied.isEmpty())
        assertEquals(listOf("brand"), review.lowConfidence.map { it.field })
    }

    @Test
    fun ocrFallbackConfidenceStaysBelowTheBar() {
        // Lockstep with US-1333: on-device OCR must never auto-apply.
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("size" to s("M", 0.4, "live-text"))),
        )
        assertTrue(review.applied.isEmpty())
        assertEquals("On-device OCR", review.lowConfidence.single().sourceLabel)
    }

    @Test
    fun appliedFieldsCarryTheUndoTarget() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("brand" to s("Patagonia", 0.9))),
            existingValues = mapOf("brand" to "Arc'teryx"),
        )
        assertEquals("Arc'teryx", review.applied.single().previousValue)
    }

    // ── conflicts ────────────────────────────────────────────────────────

    @Test
    fun conflictOnAReviewField_theTagWins() {
        // US-1217: a printed care tag beats a drape estimate.
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(
                suggestions = mapOf("size" to s("L", 0.95)),
                conflicts = listOf(FieldConflict("size", textValue = "M", photoValue = "L")),
            ),
        )
        val entry = review.lowConfidence.single()
        assertEquals("M", entry.suggestion.value)
        assertEquals("conflict:tag", entry.suggestion.source)
        // Demoted below the bar, so a 0.95 photo guess can no longer sneak in.
        assertTrue(review.applied.isEmpty())
    }

    @Test
    fun conflictOnAReviewField_isInjectedEvenWithNoPriorSuggestion() {
        // The tag reading is evidence in its own right.
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(
                conflicts = listOf(FieldConflict("brand", textValue = "Lee", photoValue = "Levi's")),
            ),
        )
        assertEquals("Lee", review.lowConfidence.single().suggestion.value)
    }

    @Test
    fun conflictOnAnyOtherField_keepsTheValueButDemotesIt() {
        // US-1530.
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(
                suggestions = mapOf("color" to s("Navy", 0.95)),
                conflicts = listOf(FieldConflict("color", textValue = "Blue", photoValue = "Navy")),
            ),
        )
        val entry = review.lowConfidence.single()
        assertEquals("Navy", entry.suggestion.value)
        assertEquals("conflict:photo", entry.suggestion.source)
        assertEquals(0.4, entry.suggestion.confidence, 1e-9)
    }

    @Test
    fun demotionNeverRaisesAnAlreadyLowerConfidence() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(
                suggestions = mapOf("color" to s("Navy", 0.1)),
                conflicts = listOf(FieldConflict("color", textValue = "Blue", photoValue = "Navy")),
            ),
        )
        assertEquals(0.1, review.lowConfidence.single().suggestion.confidence, 1e-9)
    }

    @Test
    fun aConflictedFieldCanNeverAutoApply() {
        // The whole point of both rules.
        for (field in listOf("size", "brand", "department", "color", "material")) {
            val review = AiExtractReview.build(
                "i1",
                AiExtractResponse(
                    suggestions = mapOf(field to s("X", 1.0)),
                    conflicts = listOf(FieldConflict(field, textValue = "Y", photoValue = "X")),
                ),
            )
            assertTrue("$field auto-applied despite a conflict", review.applied.isEmpty())
        }
    }

    @Test
    fun aBlankTagValueDoesNotWipeTheSuggestion() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(
                suggestions = mapOf("size" to s("L", 0.9)),
                conflicts = listOf(FieldConflict("size", textValue = "  ", photoValue = "L")),
            ),
        )
        assertEquals("L", review.applied.single().value)
    }

    // ── ordering ─────────────────────────────────────────────────────────

    @Test
    fun entriesAreAlphabeticalAndStable() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(
                suggestions = mapOf(
                    "size" to s("M", 0.9),
                    "brand" to s("Nike", 0.9),
                    "color" to s("Red", 0.9),
                ),
            ),
        )
        assertEquals(listOf("brand", "color", "size"), review.applied.map { it.field })
    }

    // ── title seed ───────────────────────────────────────────────────────

    @Test
    fun titleSeedPrefersAnActualTitle() {
        assertEquals(
            "Patagonia Synchilla Fleece",
            AiExtractReview.bestTitleSeed(
                mapOf(
                    "title" to s("Patagonia Synchilla Fleece", 0.2),
                    "brand" to s("Patagonia", 0.9),
                ),
            ),
        )
    }

    @Test
    fun titleSeedIgnoresTheConfidenceBar() {
        // A low-confidence guess beats landing on "Untitled item".
        assertEquals("Nike M", AiExtractReview.bestTitleSeed(
            mapOf("brand" to s("Nike", 0.1), "size" to s("M", 0.1)),
        ))
    }

    @Test
    fun titleSeedPrefersStyleOverSize() {
        assertEquals("Nike Air Max", AiExtractReview.bestTitleSeed(
            mapOf(
                "brand" to s("Nike", 0.9),
                "style" to s("Air Max", 0.9),
                "size" to s("M", 0.9),
            ),
        ))
    }

    @Test
    fun titleSeedGivesUpWithoutABrand() {
        assertNull(AiExtractReview.bestTitleSeed(mapOf("size" to s("M", 0.9))))
    }

    // ── feedback signal ──────────────────────────────────────────────────

    @Test
    fun keptFieldsAreReportedAsAccepted() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("brand" to s("Nike", 0.9))),
        )
        val feedback = AiExtractReview.feedback(review, setOf("brand"), emptySet())
        assertEquals(mapOf("brand" to "Nike"), feedback.acceptedFields)
        assertNull(feedback.correctedFields)
    }

    @Test
    fun anUndoneFieldIsReportedAsACorrection() {
        // The most valuable signal in the flow — the AI was actively wrong.
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("brand" to s("Nike", 0.9))),
            existingValues = mapOf("brand" to "Adidas"),
        )
        val feedback = AiExtractReview.feedback(review, emptySet(), emptySet())
        assertEquals(
            mapOf("brand" to AiCorrection(suggested = "Nike", final = "Adidas")),
            feedback.correctedFields,
        )
        assertNull(feedback.acceptedFields)
    }

    @Test
    fun anUndoneFieldWithNoPriorValueReportsAnEmptyFinal() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("brand" to s("Nike", 0.9))),
        )
        val feedback = AiExtractReview.feedback(review, emptySet(), emptySet())
        assertEquals("", feedback.correctedFields?.get("brand")?.final)
    }

    @Test
    fun emptyCorrectionsAreOmittedEntirely() {
        // The server treats a supplied object as authoritative, so sending an
        // empty one would clobber corrections recorded earlier.
        val review = AiExtractReview.build("i1", AiExtractResponse())
        val feedback = AiExtractReview.feedback(review, emptySet(), emptySet())
        assertNull(feedback.correctedFields)
        assertNull(feedback.acceptedFields)
    }

    // ── resolved values ──────────────────────────────────────────────────

    @Test
    fun resolvedValuesRestoreThePreviousValueForUndoneFields() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("brand" to s("Nike", 0.9))),
            existingValues = mapOf("brand" to "Adidas"),
        )
        assertEquals(
            mapOf("brand" to "Adidas"),
            AiExtractReview.resolvedValues(review, emptySet(), emptySet()),
        )
    }

    @Test
    fun optedInLowConfidenceValuesAreIncludedWithTheirSource() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("size" to s("M", 0.4, "live-text"))),
        )
        assertEquals(
            mapOf("size" to "M"),
            AiExtractReview.resolvedValues(review, emptySet(), setOf("size")),
        )
        assertEquals(
            mapOf("size" to "live-text"),
            AiExtractReview.resolvedSources(review, emptySet(), setOf("size")),
        )
    }

    @Test
    fun unacceptedLowConfidenceValuesAreNotWritten() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(suggestions = mapOf("size" to s("M", 0.4))),
        )
        assertTrue(AiExtractReview.resolvedValues(review, emptySet(), emptySet()).isEmpty())
    }

    // ── quota ────────────────────────────────────────────────────────────

    @Test
    fun quotaIsHiddenWhenUnknownOrUnlimited() {
        fun quota(n: Int) = AiExtractReview.build(
            "i1", AiExtractResponse(actionsRemaining = n),
        ).quotaLabel
        // No server call happened — claiming "0 left" would be a lie.
        assertNull(quota(AiExtractResponse.ACTIONS_REMAINING_UNKNOWN))
        assertNull(quota(AiExtractResponse.ACTIONS_REMAINING_UNLIMITED))
    }

    @Test
    fun quotaIsSurfacedWhenKnown() {
        fun quota(n: Int) = AiExtractReview.build(
            "i1", AiExtractResponse(actionsRemaining = n),
        ).quotaLabel
        assertEquals("No AI actions left this period", quota(0))
        assertEquals("1 AI action left this period", quota(1))
        assertEquals("7 AI actions left this period", quota(7))
    }

    // ── review summary ───────────────────────────────────────────────────

    @Test
    fun measurementsCountTowardTheAppliedTotal() {
        val review = AiExtractReview.build(
            "i1",
            AiExtractResponse(
                suggestions = mapOf("brand" to s("Nike", 0.9)),
                measurements = mapOf("chest" to 21.0, "length" to 28.0),
            ),
        )
        assertEquals(3, review.appliedCount)
        assertEquals("AI filled 3 fields — review", review.entryPointLabel)
    }

    @Test
    fun anEmptyExtractHasNothingToReview() {
        assertFalse(AiExtractReview.build("i1", AiExtractResponse()).hasSomethingToReview)
    }

    @Test
    fun aPendingEbayCategoryAloneIsWorthShowing() {
        assertTrue(
            AiExtractReview.build("i1", AiExtractResponse(ebayPending = true)).hasSomethingToReview,
        )
    }
}
