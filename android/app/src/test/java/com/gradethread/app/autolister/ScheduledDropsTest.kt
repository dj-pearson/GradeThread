package com.gradethread.app.autolister

import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * US-1361: the timezone conversion behind a scheduled drop.
 *
 * A seller picks "Sunday 7pm" meaning their evening; the column is UTC; a
 * server cron publishes it. Getting this wrong drops a listing at breakfast, so
 * the conversion — including both daylight-saving edges — is pinned here.
 */
class ScheduledDropsTest {

    private val newYork = ZoneId.of("America/New_York")
    private val london = ZoneId.of("Europe/London")

    @Test
    fun `a local evening converts to the right UTC instant`() {
        // 2026-08-03 19:00 in New York is EDT (UTC-4) → 23:00Z.
        val instant = ScheduledDrops.toInstant(
            LocalDate.of(2026, 8, 3),
            LocalTime.of(19, 0),
            newYork,
        )
        assertEquals(Instant.parse("2026-08-03T23:00:00Z"), instant)
    }

    @Test
    fun `winter and summer differ by the offset, not by the wall clock`() {
        // Same 19:00 local, five hours out in January (EST) and four in August.
        val winter = ScheduledDrops.toInstant(LocalDate.of(2026, 1, 10), LocalTime.of(19, 0), newYork)
        val summer = ScheduledDrops.toInstant(LocalDate.of(2026, 8, 3), LocalTime.of(19, 0), newYork)
        assertEquals(Instant.parse("2026-01-11T00:00:00Z"), winter)
        assertEquals(Instant.parse("2026-08-03T23:00:00Z"), summer)
    }

    @Test
    fun `the wire value is UTC`() {
        val wire = ScheduledDrops.toWire(LocalDate.of(2026, 8, 3), LocalTime.of(19, 0), newYork)
        assertTrue("wire was $wire", wire.endsWith("Z"))
        assertEquals("2026-08-03T23:00:00Z", wire)
    }

    @Test
    fun `a stored instant comes back in the seller's own zone`() {
        val local = ScheduledDrops.toLocal("2026-08-03T23:00:00Z", newYork)!!
        assertEquals(LocalDate.of(2026, 8, 3), local.toLocalDate())
        assertEquals(LocalTime.of(19, 0), local.toLocalTime())
    }

    @Test
    fun `a timestamp with an offset is honoured, not misread`() {
        // PostgREST emits offsets as well as Z; both are the same instant.
        val local = ScheduledDrops.toLocal("2026-08-03T23:00:00+00:00", newYork)!!
        assertEquals(LocalTime.of(19, 0), local.toLocalTime())
    }

    @Test
    fun `an unparseable timestamp yields nothing rather than a wrong time`() {
        assertNull(ScheduledDrops.toLocal(null, newYork))
        assertNull(ScheduledDrops.toLocal("", newYork))
        assertNull(ScheduledDrops.toLocal("not a date", newYork))
    }

    // ── daylight saving, both directions ─────────────────────────────────────

    @Test
    fun `a time that does not exist is shifted, and the seller is told`() {
        // 2026-03-08, New York: 02:00–03:00 never happens.
        val date = LocalDate.of(2026, 3, 8)
        val time = LocalTime.of(2, 30)
        val instant = ScheduledDrops.toInstant(date, time, newYork)
        // java.time pushes it past the gap: 03:30 EDT = 07:30Z.
        assertEquals(Instant.parse("2026-03-08T07:30:00Z"), instant)
        // US-2976: the resource id, plus the two times it names. WHICH hour
        // the drop actually lands on is the number a seller acts on, and it
        // travels as an argument now rather than inside an English sentence.
        val note = ScheduledDrops.scheduleNote(date, time, newYork)
        assertNotNull("a skipped hour must be explained", note)
        assertEquals(R.string.schedule_dst_gap, note!!.res)
        assertEquals(2, note.args.size)
        assertEquals(ScheduledDrops.formatTime(LocalTime.of(3, 30)), note.args[1])
    }

    @Test
    fun `a time that happens twice takes the first, and says so`() {
        // 2026-11-01, New York: 01:00–02:00 runs twice.
        val date = LocalDate.of(2026, 11, 1)
        val time = LocalTime.of(1, 30)
        val instant = ScheduledDrops.toInstant(date, time, newYork)
        // The earlier offset (EDT, UTC-4) → 05:30Z, not 06:30Z.
        assertEquals(Instant.parse("2026-11-01T05:30:00Z"), instant)
        val note = ScheduledDrops.scheduleNote(date, time, newYork)
        assertNotNull(note)
        assertEquals(R.string.schedule_dst_overlap, note!!.res)
        assertEquals(listOf<Any>(ScheduledDrops.formatTime(time)), note.args)
    }

    @Test
    fun `an ordinary time gets no warning`() {
        assertNull(
            ScheduledDrops.scheduleNote(LocalDate.of(2026, 8, 3), LocalTime.of(19, 0), newYork),
        )
        assertNull(
            ScheduledDrops.scheduleNote(LocalDate.of(2026, 8, 3), LocalTime.of(19, 0), london),
        )
    }

    // ── due-ness ─────────────────────────────────────────────────────────────

    @Test
    fun `a past time is due, not lost`() {
        // The cron publishes it on the next pass, which the copy must say.
        val now = Instant.parse("2026-08-03T12:00:00Z")
        assertTrue(ScheduledDrops.isDue(Instant.parse("2026-08-03T11:59:00Z"), now))
        assertTrue("exactly now counts as due", ScheduledDrops.isDue(now, now))
        assertFalse(ScheduledDrops.isDue(Instant.parse("2026-08-03T12:01:00Z"), now))
    }

    @Test
    fun `the status line distinguishes upcoming from overdue`() {
        val now = Instant.parse("2026-08-03T12:00:00Z")
        assertEquals(
            R.string.schedule_not_scheduled,
            ScheduledDrops.statusLine(null, newYork, now).res,
        )
        // Upcoming and overdue are SEPARATE resources. That is the distinction
        // the line exists for, and asserting the id says it exactly.
        assertEquals(
            R.string.schedule_publishes,
            ScheduledDrops.statusLine("2026-08-04T23:00:00Z", newYork, now).res,
        )
        assertEquals(
            R.string.schedule_was_due,
            ScheduledDrops.statusLine("2026-08-01T23:00:00Z", newYork, now).res,
        )
    }

    // ── ordering ─────────────────────────────────────────────────────────────

    @Test
    fun `scheduled drafts sort soonest first, unscheduled last`() {
        val drafts = listOf(
            DraftListing(id = "none"),
            DraftListing(id = "later", scheduledPublishAt = "2026-08-05T10:00:00Z"),
            DraftListing(id = "sooner", scheduledPublishAt = "2026-08-04T10:00:00Z"),
        )
        assertEquals(
            listOf("sooner", "later", "none"),
            ScheduledDrops.ordered(drafts).map { it.id },
        )
        assertEquals(listOf("later", "sooner"), ScheduledDrops.scheduled(drafts).map { it.id })
    }
}
