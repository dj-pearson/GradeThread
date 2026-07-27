package com.gradethread.app.money

import com.gradethread.app.money.MoneyFixtures.expense
import com.gradethread.app.money.MoneyFixtures.ms
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * US-1364: the expense form's rules.
 */
class ExpenseDraftTest {

    private val today = ms(2026, 6, 20)

    private fun draft(amount: String) =
        ExpenseDraft(amountText = amount, spentOnMs = today)

    @Test
    fun anAmountIsRequired() {
        assertNotNull(draft("").validate())
        assertNotNull(draft("   ").validate())
        assertNull(draft("12.50").validate())
    }

    @Test
    fun zeroIsRejectedRatherThanStored() {
        // A 0.00 expense is always a mistyped entry, and storing it silently
        // leaves a meaningless row the seller has to hunt down later.
        assertNotNull(draft("0").validate())
        assertNotNull(draft("0.00").validate())
    }

    @Test
    fun aPastedNegativeCannotInvertTheLedger() {
        // US-1184's clamp, inherited from CurrencyAmount: a negative expense
        // would ADD to profit. It clamps to zero, which then fails validation
        // rather than being stored.
        assertEquals(0L, draft("-20").amountCents)
        assertNotNull(draft("-20").validate())
    }

    @Test
    fun currencySymbolsAndSeparatorsAreTolerated() {
        assertEquals(1250L, draft("$12.50").amountCents)
        assertEquals(123456L, draft("1,234.56").amountCents)
    }

    @Test
    fun aCategoryIsRequired() {
        assertNotNull(draft("5.00").copy(category = "").validate())
    }

    @Test
    fun theEntityStoresAnExactTwoDecimalAmount() {
        // Cents → dollars at the boundary, so every Money.sum over the stored
        // column is drift-free by construction.
        val entity = draft("12.50").toEntity("e1")
        assertEquals(12.50, entity.amount, 0.0)
        assertEquals("e1", entity.id)
        assertEquals(today, entity.spentOn)
    }

    @Test
    fun aBlankNoteIsStoredAsNullNotAnEmptyString() {
        assertNull(draft("5.00").copy(description = "   ").toEntity("e1").expenseDescription)
        assertEquals(
            "Poly mailers",
            draft("5.00").copy(description = "  Poly mailers  ").toEntity("e1").expenseDescription,
        )
    }

    @Test
    fun editingRoundTripsWithoutShavingACent() {
        // REGRESSION: `(0.29 * 100).toLong()` is 28, because 0.29 is really
        // 0.28999999…. A plain cast quietly took a cent off the amount every
        // time the seller opened the row to edit it.
        val stored = expense("e1", amount = 0.29, spentOn = today)
        val reopened = ExpenseDraft.from(stored)
        assertEquals("0.29", reopened.amountText)
        assertEquals(0.29, reopened.toEntity("e1").amount, 0.0)

        // And the id is carried, so a save UPSERTS rather than duplicating.
        assertEquals("e1", reopened.id)
    }

    @Test
    fun editingSeedsEveryFieldFromTheStoredRow() {
        val stored = expense("e1", amount = 40.0, spentOn = today, category = "shipping", itemId = "i1")
        val reopened = ExpenseDraft.from(stored)
        assertEquals("shipping", reopened.category)
        assertEquals("i1", reopened.inventoryItemId)
        assertEquals(today, reopened.spentOnMs)
        assertTrue(reopened.isValid)
    }

    @Test
    fun anUnknownCategoryIsShownAsItselfNotRelabeled() {
        // A category the server knows and this build doesn't must not silently
        // display as "Other" — the seller would think their choice was lost.
        assertEquals("Supplies", ExpenseDraft.labelFor("supplies"))
        assertEquals("Warehousing", ExpenseDraft.labelFor("warehousing"))
    }

    @Test
    fun theDateColumnIsSentAsALocalDateNotATimestamp() {
        // `spent_on` is a DATE. Sending a full timestamp makes Postgres truncate
        // in UTC, which moves an evening expense to the next day east of
        // Greenwich — and to the previous day west of it.
        val evening = ms(2026, 6, 20, hour = 22)
        assertEquals(
            "2026-06-20",
            ExpenseDraft.isoDate(evening, ZoneId.of("America/Chicago")),
        )
    }
}
