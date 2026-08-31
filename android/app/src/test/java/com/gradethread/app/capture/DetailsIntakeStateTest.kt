package com.gradethread.app.capture

import com.gradethread.app.R

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1330: form validation, the autosave signature, and the batch-reset rule.
 * Pure — no Room, no Compose.
 */
class DetailsIntakeStateTest {

    @Test
    fun titleIsTheOnlyRequiredField() {
        // Matches the web intake form: everything else is optional.
        val everythingButTitle = DetailsIntakeState(
            sku = "A1",
            brand = "Nike",
            size = "L",
            notes = "hi",
        )
        assertFalse(everythingButTitle.canSubmit)
        assertEquals(R.string.intake_title_required, everythingButTitle.titleValidationMessage)

        val titled = DetailsIntakeState(title = "Vintage tee")
        assertTrue(titled.canSubmit)
        assertNull(titled.titleValidationMessage)
    }

    @Test
    fun whitespaceOnlyTitle_doesNotCount() {
        assertFalse(DetailsIntakeState(title = "   ").canSubmit)
    }

    @Test
    fun blankFormIsNotWorthPersisting() {
        assertFalse(DetailsIntakeState().hasContent)
        // Category/status alone are defaults the user never touched.
        assertFalse(DetailsIntakeState(category = "shoes", status = "sourced").hasContent)
        assertTrue(DetailsIntakeState(sku = "A1").hasContent)
        assertTrue(DetailsIntakeState(notes = "n").hasContent)
    }

    @Test
    fun draftSignature_changesWithEveryField() {
        val base = DetailsIntakeState(title = "t")
        val mutations = listOf(
            base.copy(title = "t2"), base.copy(sku = "s"), base.copy(brand = "b"),
            base.copy(style = "st"), base.copy(size = "sz"), base.copy(color = "c"),
            base.copy(material = "m"), base.copy(category = "shoes"),
            base.copy(status = "sourced"), base.copy(sourceId = "src"),
            base.copy(container = "bin"), base.copy(sourcedBy = "me"),
            base.copy(purchaseDate = "2026-01-01"), base.copy(purchasePriceText = "5"),
            base.copy(notes = "n"),
        )
        for (m in mutations) assertNotEquals(base.draftSignature, m.draftSignature)
    }

    @Test
    fun draftSignature_cannotCollideAcrossFieldBoundaries() {
        // A separator a user can type (a comma) would make these identical.
        val a = DetailsIntakeState(title = "ab", sku = "c")
        val b = DetailsIntakeState(title = "a", sku = "bc")
        assertNotEquals(a.draftSignature, b.draftSignature)
    }

    @Test
    fun titleIsClampedNotDropped() {
        val long = DetailsIntakeState(title = "x".repeat(200)).clampTitle()
        assertEquals(DetailsIntakeState.TITLE_LIMIT, long.title.length)
        // Under the limit is untouched.
        assertEquals("short", DetailsIntakeState(title = "short").clampTitle().title)
    }

    @Test
    fun addAnother_clearsIdentityButKeepsTheSourcingContext() {
        val filled = DetailsIntakeState(
            title = "Tee", sku = "A1", brand = "Nike", notes = "n",
            purchasePriceText = "12.00",
            category = "shoes", status = "sourced",
            sourceId = "src-1", container = "Bin 4", sourcedBy = "Dana",
            purchaseDate = "2026-01-02",
        )
        val next = filled.resetForAddAnother()

        // Cleared — this is a different garment.
        assertEquals("", next.title)
        assertEquals("", next.sku)
        assertEquals("", next.brand)
        assertEquals("", next.notes)
        assertEquals("", next.purchasePriceText)
        // Kept — the next item came from the same haul.
        assertEquals("src-1", next.sourceId)
        assertEquals("Bin 4", next.container)
        assertEquals("Dana", next.sourcedBy)
        assertEquals("2026-01-02", next.purchaseDate)
        assertEquals("shoes", next.category)
        assertEquals("sourced", next.status)
    }

    @Test
    fun enumsFallBackInsteadOfThrowing_onUnknownWireValues() {
        // A draft written by a newer build must not break an older one.
        assertEquals(FlipdeskCategory.CLOTHING, FlipdeskCategory.from("not_a_category"))
        assertEquals(FlipdeskCategory.CLOTHING, FlipdeskCategory.from(null))
        assertEquals(FlipdeskCategory.SPORTS_CARDS, FlipdeskCategory.from("sports_cards"))
        assertEquals(IntakeStatus.CATALOGED, IntakeStatus.from("listed"))
        assertEquals(IntakeStatus.SOURCED, IntakeStatus.from("sourced"))
    }
}
