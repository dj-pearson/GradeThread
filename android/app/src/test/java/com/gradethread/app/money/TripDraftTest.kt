package com.gradethread.app.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * US-3000: the trip form's rules, without a Compose harness.
 *
 * Miles are the only number here and they are carried as integer TENTHS, for the
 * same reason money is carried as cents. A log that stores 12.299999999999999
 * miles produces a deduction the seller cannot reconcile against their own
 * arithmetic, and "the app is wrong about my mileage" is the kind of thing that
 * loses a seller's trust in every other figure on the screen.
 */
class TripDraftTest {

    private fun draft(miles: String) =
        TripDraft(milesText = miles, tripDateMs = TripDraft.anchor(LocalDate.of(2026, 3, 12)))

    @Test
    fun milesParseToExactTenths() {
        assertEquals(123L, draft("12.3").tenthsOfMile)
        assertEquals(120L, draft("12").tenthsOfMile)
        assertEquals(120L, draft("12.").tenthsOfMile)
        assertEquals(5L, draft("0.5").tenthsOfMile)
        assertEquals(3L, draft(".3").tenthsOfMile)
        // Whitespace and a thousands comma are what a real keyboard produces.
        assertEquals(12345L, draft(" 1,234.5 ").tenthsOfMile)
    }

    @Test
    fun aSecondDecimalIsTruncatedRatherThanRounded() {
        // Rounding 12.35 up to 12.4 invents a distance the seller did not drive,
        // and the column is numeric(8,1) so it cannot hold it either way.
        assertEquals(123L, draft("12.35").tenthsOfMile)
        assertEquals(123L, draft("12.39").tenthsOfMile)
    }

    @Test
    fun theStoredDoubleIsExactlyOneDecimalPlace() {
        // 12.3 is not representable in binary floating point, so the check is
        // that the value we WRITE is the one the seller typed to 1dp.
        val entity = draft("12.3").toEntity("id")
        assertEquals(12.3, entity.miles, 0.0)
        assertEquals("12.3", String.format(java.util.Locale.ROOT, "%.1f", entity.miles))
    }

    @Test
    fun halfTypedTextStaysOnScreen() {
        // "12." must not snap to "12.0" under the cursor. It is held as raw text
        // and only parsed at the edges, which is why this is a property of the
        // draft rather than of the text field.
        val d = draft("12.")
        assertEquals("12.", d.milesText)
        assertTrue(d.isValid)
    }

    @Test
    fun whatCannotBeSaved() {
        assertEquals("Enter the miles.", draft("").validate())
        assertEquals("Enter the miles.", draft("abc").validate())
        assertEquals("Enter the miles.", draft("1.2.3").validate())
        assertEquals("A trip has to be more than zero miles.", draft("0").validate())
        assertEquals("A trip has to be more than zero miles.", draft("0.0").validate())
        // The server's CHECK is miles < 100000. Rejecting here keeps a row
        // Postgres will never accept out of the offline queue, where it would
        // retry for ever.
        assertEquals("That is more miles than a trip can be.", draft("100000").validate())
        assertNull(draft("99999.9").validate())
    }

    @Test
    fun aPurposeIsRequiredAndDefaultsToSourcing() {
        assertEquals("sourcing", TripDraft.today().purpose)
        assertEquals("Say what the trip was for.", draft("10").copy(purpose = "  ").validate())
        // The picker's wire values all resolve to a label; anything else falls
        // back to itself, because `purpose` is free text on the server and a
        // seller's own word must not render as blank.
        assertEquals("Post office", TripDraft.label("post_office"))
        assertEquals("dog walking", TripDraft.label("dog walking"))
    }

    @Test
    fun blankLocationsAreStoredAsNullNotEmptyString() {
        // An empty string and NULL read the same on screen and differently in
        // every query. The row builder is the one place to settle it.
        val entity = draft("10").copy(startLocation = "  ", endLocation = "Goodwill")
            .toEntity("id")
        assertNull(entity.startLocation)
        assertEquals("Goodwill", entity.endLocation)
    }

    @Test
    fun todayIsADateAnchorNotTheWallClock() {
        // AC3 again, at the entry point. TripDraft.today() must produce a UTC
        // midnight, or an evening trip west of Greenwich is logged as tomorrow.
        val today = TripDraft.today()
        assertEquals(0L, today.tripDateMs % 86_400_000L)
        assertNotNull(CalendarDateField.parseIso(CalendarDateField.iso(today.tripDateMs)))
    }

    @Test
    fun anEditKeepsItsId() {
        // The repository upserts, so a draft that lost its id would create a
        // second trip instead of correcting the first.
        val entity = draft("10").copy(id = "abc").toEntity("abc")
        assertEquals("abc", entity.id)
    }
}
