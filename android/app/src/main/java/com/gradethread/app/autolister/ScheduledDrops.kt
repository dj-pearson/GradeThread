package com.gradethread.app.autolister

import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * US-1361: scheduling a draft to publish later.
 *
 * The whole surface is a timezone conversion with consequences. A seller picks
 * "Sunday 7pm" meaning their own evening; the column is UTC; a server cron
 * publishes when it comes due. Get the conversion wrong and the drop lands at
 * breakfast — so the arithmetic lives here, pure, rather than inline in a
 * picker callback.
 *
 * Deliberately NO client-side scheduling: nothing on the phone waits for the
 * time to arrive. The publish-due cron owns that, which is why a drop still
 * happens with the app closed, uninstalled, or the phone flat.
 */
object ScheduledDrops {

    /**
     * The instant to store, from a local date + time in [zone].
     *
     * DST is the interesting part, and java.time already resolves it the way a
     * person would expect: a local time that DOESN'T EXIST (spring forward)
     * shifts forward by the gap, and one that happens TWICE (fall back) takes
     * the first, earlier offset. Both are surfaced to the seller by
     * [scheduleNote] rather than silently applied.
     */
    fun toInstant(date: LocalDate, time: LocalTime, zone: ZoneId): Instant =
        ZonedDateTime.of(LocalDateTime.of(date, time), zone).toInstant()

    /** The UTC string the column takes. */
    fun toWire(date: LocalDate, time: LocalTime, zone: ZoneId): String = toInstant(date, time, zone).toString()

    /** A stored instant back in the seller's own zone, or null if unparseable. */
    fun toLocal(iso: String?, zone: ZoneId): ZonedDateTime? {
        if (iso.isNullOrBlank()) return null
        return runCatching { Instant.parse(iso).atZone(zone) }
            .recoverCatching { ZonedDateTime.parse(iso).withZoneSameInstant(zone) }
            .getOrNull()
    }

    /**
     * When the picked time isn't the time that will actually be used.
     *
     * Only DST does this. Saying so beats a drop that quietly lands an hour off
     * the hour the seller chose.
     */
    fun scheduleNote(date: LocalDate, time: LocalTime, zone: ZoneId): UiMessage? {
        val wanted = LocalDateTime.of(date, time)
        val resolved = ZonedDateTime.of(wanted, zone)
        if (resolved.toLocalDateTime() != wanted) {
            // The clocks skipped over this time entirely.
            return UiMessage(
                R.string.schedule_dst_gap,
                args = listOf(formatTime(time), formatTime(resolved.toLocalTime())),
            )
        }
        val rules = zone.rules
        if (rules.getValidOffsets(wanted).size > 1) {
            return UiMessage(R.string.schedule_dst_overlap, args = listOf(formatTime(time)))
        }
        return null
    }

    /** A time already gone: the cron publishes it on its next pass, not never. */
    fun isDue(instant: Instant, now: Instant): Boolean = !instant.isAfter(now)

    val PAST_TIME_NOTE = UiMessage(R.string.schedule_past_time)

    /** "Sun, 3 Aug 2026, 19:00" in the seller's own zone. */
    fun formatLocal(zoned: ZonedDateTime, locale: Locale = Locale.getDefault()): String = zoned.format(
        DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
            .withLocale(locale),
    )

    fun formatTime(time: LocalTime, locale: Locale = Locale.getDefault()): String =
        time.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))

    /**
     * What a draft's schedule row says.
     *
     * A scheduled time in the past is called out rather than shown as a normal
     * future drop: it means the cron hasn't got to it yet, and a seller staring
     * at yesterday's timestamp deserves to know it's still coming.
     */
    fun statusLine(scheduledAt: String?, zone: ZoneId, now: Instant, locale: Locale = Locale.getDefault()): UiMessage {
        val local = toLocal(scheduledAt, zone) ?: return UiMessage(R.string.schedule_not_scheduled)
        val text = formatLocal(local, locale)
        // US-2976: two resources rather than one with a swapped verb. "Was due"
        // and "Publishes" are the difference between a drop that is late and
        // one that is coming, which is the whole point of the line.
        return UiMessage(
            if (isDue(local.toInstant(), now)) {
                R.string.schedule_was_due
            } else {
                R.string.schedule_publishes
            },
            args = listOf(text),
        )
    }

    /** Drafts with a schedule, soonest first; unscheduled ones after them. */
    fun ordered(drafts: List<DraftListing>): List<DraftListing> = drafts.sortedWith(
        compareBy(
            { it.scheduledPublishAt == null },
            { it.scheduledPublishAt ?: "" },
        ),
    )

    fun scheduled(drafts: List<DraftListing>): List<DraftListing> =
        drafts.filter { !it.scheduledPublishAt.isNullOrBlank() }
}
