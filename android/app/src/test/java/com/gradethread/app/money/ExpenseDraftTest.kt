package com.gradethread.app.money

import com.gradethread.app.money.MoneyFixtures.expense
import com.gradethread.app.money.MoneyFixtures.ms
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
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

/**
 * US-2339: an expense date must survive the edit-sync round trip.
 *
 * `spent_on` is a date-only column. The sync parses it at UTC midnight
 * (`RealtimeService.parseTimestamp`), and `isoDate` used to format it back in
 * the DEVICE zone - so for a seller west of Greenwich the day walked BACK one
 * per cycle, compounding because `wireBody` serves insert and edit from one
 * path.
 *
 * Pinned to America/Chicago rather than the runner's zone: a test that used
 * the default would pass on a UTC CI machine, which is exactly where this
 * would never be caught.
 */
class ExpenseDateRoundTripTest {

    private val chicago: ZoneId = ZoneId.of("America/Chicago")

    /** What the sync does with the server's bare date. */
    private fun parseFromServer(date: String): Long =
        java.time.LocalDate.parse(date)
            .atStartOfDay(java.time.ZoneOffset.UTC)
            .toInstant()
            .toEpochMilli()

    /**
     * Zones on both sides of Greenwich, so neither can be the runner's.
     *
     * A round-trip test leaning on the DEFAULT zone would pass on a UTC CI
     * machine while the bug was live for every seller not on UTC - which is
     * exactly where it would never be caught.
     */
    private val deviceZones = listOf(
        ZoneId.of("America/Chicago"),
        ZoneId.of("Pacific/Auckland"),
        ZoneId.of("Europe/Berlin"),
    )

    @Test
    fun `the date survives three edit cycles in any device zone`() {
        for (zone in deviceZones) {
            var stored = parseFromServer("2026-08-12")
            repeat(3) {
                val onTheWire = ExpenseDraft.isoDate(stored)
                assertEquals("in $zone", "2026-08-12", onTheWire)
                stored = parseFromServer(onTheWire)
            }
            // The wire value is the UTC reading, whatever the device zone is.
            //
            // NOT asserted as "differs from the device reading": Berlin is EAST
            // of Greenwich, so UTC midnight on the 12th is still the 12th there,
            // and only a negative-offset zone shifts the date at all. That
            // assertion looked stronger and was simply wrong - it failed against
            // correct code on the Berlin case.
            //
            // The runner-independent guarantee is the explicit
            // `EXPENSE_ZONE == ZoneOffset.UTC` case below; this one shows the
            // round trip holding across real device zones.
            assertEquals(
                "the wire date is not the UTC reading in $zone",
                ExpenseDraft.isoDate(stored, java.time.ZoneOffset.UTC),
                ExpenseDraft.isoDate(stored),
            )
        }
    }

    @Test
    fun `a date typed on the form round-trips to the same day`() {
        // The other half: entry has to agree with the sync, or a NEW expense
        // starts one day off instead of drifting there.
        val typed = java.time.LocalDate.parse("2026-01-01")
        val stored = ExpenseDraft.startOfDayMs(typed)
        assertEquals("2026-01-01", ExpenseDraft.isoDate(stored))
        assertEquals(stored, parseFromServer("2026-01-01"))
    }

    @Test
    fun `the anchor zone is not the device zone`() {
        // The property, stated once. If EXPENSE_ZONE ever becomes
        // ZoneId.systemDefault() every case above still passes on a UTC runner
        // while the bug is live for every seller who is not on UTC.
        assertEquals(java.time.ZoneOffset.UTC, ExpenseDraft.EXPENSE_ZONE)
        assertNotEquals(chicago, ExpenseDraft.EXPENSE_ZONE)
    }

    @Test
    fun `formatting in the device zone is what used to break it`() {
        // Demonstrates the defect rather than describing it: the same instant,
        // read in Chicago, is the day before. This is what wireBody did.
        val stored = parseFromServer("2026-08-12")
        assertEquals("2026-08-11", ExpenseDraft.isoDate(stored, chicago))
        assertEquals("2026-08-12", ExpenseDraft.isoDate(stored))
    }
}
