package com.gradethread.app.money

import com.gradethread.app.R
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
        assertEquals(R.string.trip_invalid_no_miles, draft("").validate())
        assertEquals(R.string.trip_invalid_no_miles, draft("abc").validate())
        assertEquals(R.string.trip_invalid_no_miles, draft("1.2.3").validate())
        assertEquals(R.string.trip_invalid_zero_miles, draft("0").validate())
        assertEquals(R.string.trip_invalid_zero_miles, draft("0.0").validate())
        // The server's CHECK is miles < 100000. Rejecting here keeps a row
        // Postgres will never accept out of the offline queue, where it would
        // retry for ever.
        assertEquals(R.string.trip_invalid_too_many_miles, draft("100000").validate())
        assertNull(draft("99999.9").validate())
    }

    @Test
    fun aPurposeIsRequiredAndDefaultsToSourcing() {
        assertEquals("sourcing", TripDraft.today().purpose)
        // ⚠ RESOURCE IDS, NOT SENTENCES. validate() and labelRes() return
        // @StringRes ints so a Spanish seller does not read English: this class
        // is plain Kotlin and cannot reach a Context. Asserting the id is the
        // whole point - asserting a sentence here would only be possible again
        // if the localization regressed.
        assertEquals(R.string.trip_invalid_no_purpose, draft("10").copy(purpose = "  ").validate())
        // The picker's wire values all resolve to a label; anything else
        // resolves to null, because `purpose` is free text on the server and
        // the CALLER falls back to the seller's own word.
        assertEquals(R.string.trip_purpose_post_office, TripDraft.labelRes("post_office"))
        assertNull(TripDraft.labelRes("dog walking"))
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
