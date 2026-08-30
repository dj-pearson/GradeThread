package com.gradethread.app.money

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * The rule for every DATE-ONLY column this app writes.
 *
 * US-2339 is the reason this exists as one object rather than as a habit.
 * `spent_on` is a date-only column and `spentOn` was a Long carrying a calendar
 * DATE rather than a moment. The round trip was split across two zones and lost
 * a day per cycle: the sync parsed the server's bare date at UTC midnight and
 * the writer formatted it back in the DEVICE zone. For a seller in Chicago, UTC
 * midnight on the 12th is 19:00 on the 11th, so the edit wrote back the 11th,
 * the next pull parsed the 11th, and the next edit wrote the 10th. It compounded
 * on every save.
 *
 * US-3000 adds `trip_date`, which is EXACTLY the same shape of field, and AC3
 * asks specifically that the bug is not repeated. Two independent
 * implementations of "format a date for the wire" is how it would be: the
 * second one is written from memory of the first, and the drift is invisible
 * until a seller in a negative-offset zone edits a row twice.
 *
 * So there is one implementation. [ExpenseDraft] and [TripDraft] both delegate
 * here, and `CalendarDateFieldTest` proves a repeated round trip is a fixed
 * point in zones on both sides of Greenwich.
 */
object CalendarDateField {

    /**
     * `YYYY-MM-DD`. A DATE column can still arrive as a full timestamp through a
     * view or a join, and the time part of a date-only field carries no
     * information -- anything that tried to use it would be reading the zone
     * back in, which is the bug.
     */
    private const val ISO_DATE_LENGTH = 10

    /**
     * The zone every date-only field is anchored in. UTC, everywhere, always.
     *
     * Parsing AND formatting AND bucketing have to happen in the same zone. iOS
     * reached the same answer independently in US-1494
     * (`ExpenseStore.bucketingCalendar` is a UTC calendar), and a device-zone
     * read of any single one of the three re-opens the drift.
     */
    val ZONE: ZoneId = ZoneOffset.UTC

    /**
     * `YYYY-MM-DD` for a Postgres DATE column.
     *
     * Sending a full timestamp instead makes Postgres truncate in UTC, which
     * moves an evening entry to the next day east of Greenwich and to the
     * previous day west of it.
     */
    fun iso(epochMs: Long, zone: ZoneId = ZONE): String =
        Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate().toString()

    /** The epoch-ms anchor for a calendar date, in [ZONE]. */
    fun startOfDayMs(date: LocalDate): Long = date.atStartOfDay(ZONE).toInstant().toEpochMilli()

    /**
     * Parse a bare `YYYY-MM-DD` from the server back to an anchor.
     *
     * The other half of the round trip, and the half that was implicit before:
     * anything that parses a date-only column somewhere else, in some other
     * zone, is the drift coming back.
     */
    fun parseIso(value: String): Long? = runCatching {
        startOfDayMs(LocalDate.parse(value.trim().take(ISO_DATE_LENGTH)))
    }.getOrNull()

    /** Today, as an anchor. Never `System.currentTimeMillis()` for a date field. */
    fun todayMs(clock: java.time.Clock = java.time.Clock.systemUTC()): Long =
        startOfDayMs(LocalDate.now(clock.withZone(ZONE)))
}
