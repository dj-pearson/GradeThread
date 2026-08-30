package com.gradethread.app.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

/**
 * US-3000 AC3 — the date-only round trip is a FIXED POINT.
 *
 * US-2339 is the bug these assert against: `spent_on` walked back one day per
 * edit cycle because the sync parsed the server's bare date at UTC midnight and
 * the writer formatted it back in the DEVICE zone. `trip_date` is exactly the
 * same shape of column, so the rule now lives in one object and both drafts
 * delegate to it.
 *
 * THE TEST THAT MATTERS IS [repeatedRoundTripDoesNotWalk]. A single round trip
 * passed while the bug was live -- one cycle only loses the day for sellers in a
 * negative offset, and even then only if you look at the right one. It takes
 * three cycles and two hemispheres to see it.
 */
class CalendarDateFieldTest {

    /** Zones on both sides of Greenwich, plus one with a half-hour offset. */
    private val zones = listOf(
        "America/Chicago", // UTC-5/6: where US-2339 was observed
        "America/Los_Angeles",
        "UTC",
        "Europe/Berlin",
        "Asia/Kolkata", // UTC+5:30, the offset that breaks naive arithmetic
        "Pacific/Kiritimati", // UTC+14, the furthest ahead there is
    ).map(ZoneId::of)

    @Test
    fun repeatedRoundTripDoesNotWalk() {
        for (zone in zones) {
            val start = CalendarDateField.startOfDayMs(LocalDate.of(2026, 3, 12))
            var anchor = start
            // Save, pull, edit, save, pull, edit. The original defect lost a day
            // on EACH of these, so after three the date was the 9th.
            repeat(3) {
                val wire = CalendarDateField.iso(anchor)
                assertEquals("wire drifted in $zone", "2026-03-12", wire)
                anchor = CalendarDateField.parseIso(wire)
                    ?: error("could not parse back in $zone")
            }
            assertEquals("the anchor moved after three cycles in $zone", start, anchor)
        }
    }

    @Test
    fun theDeviceZoneNeverDecidesTheDate() {
        // The specific failure: 2026-03-12T00:00Z is 2026-03-11T19:00 in
        // Chicago. Formatting the anchor in the device zone yields the 11th,
        // which is the whole bug in one line.
        val anchor = CalendarDateField.startOfDayMs(LocalDate.of(2026, 3, 12))
        assertEquals(
            "this is the DEFECT, asserted so the fix below is not a coincidence",
            "2026-03-11",
            CalendarDateField.iso(anchor, ZoneId.of("America/Chicago")),
        )
        assertEquals("2026-03-12", CalendarDateField.iso(anchor))
    }

    @Test
    fun expenseAndTripUseTheSameRule() {
        // Two implementations of "format a date for the wire" is how US-2339
        // comes back, so this asserts there is only one.
        assertEquals(CalendarDateField.ZONE, ExpenseDraft.EXPENSE_ZONE)
        val anchor = CalendarDateField.startOfDayMs(LocalDate.of(2026, 1, 1))
        assertEquals(CalendarDateField.iso(anchor), ExpenseDraft.isoDate(anchor))
        assertEquals(anchor, ExpenseDraft.startOfDayMs(LocalDate.of(2026, 1, 1)))
        assertEquals(anchor, TripDraft.anchor(LocalDate.of(2026, 1, 1)))
    }

    @Test
    fun parsingToleratesWhatTheServerActuallySends() {
        // PostgREST returns a bare date for a DATE column, but a view or a join
        // can hand back a full timestamp for the same field. Taking the first
        // ten characters is deliberate: the time part of a date-only column
        // carries no information, and anything that tried to use it would be
        // reading the zone back in.
        assertEquals(
            CalendarDateField.startOfDayMs(LocalDate.of(2026, 5, 4)),
            CalendarDateField.parseIso("2026-05-04"),
        )
        assertEquals(
            CalendarDateField.startOfDayMs(LocalDate.of(2026, 5, 4)),
            CalendarDateField.parseIso("2026-05-04T23:30:00+00:00"),
        )
        assertNull(CalendarDateField.parseIso(""))
        assertNull(CalendarDateField.parseIso("not a date"))
    }

    @Test
    fun todayIsADateNotAMoment() {
        val today = CalendarDateField.todayMs()
        // Exactly midnight in the field's zone. A `System.currentTimeMillis()`
        // would be some moment during the day, and the two are different the
        // moment anything compares or buckets them.
        assertEquals(today, CalendarDateField.parseIso(CalendarDateField.iso(today)))
        assertTrue("an anchor must be a UTC midnight", today % 86_400_000L == 0L)
    }
}
