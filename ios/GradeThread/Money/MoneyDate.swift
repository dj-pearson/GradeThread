import Foundation
import SwiftUI

/// US-3014 AC2 — the one place a date-only money column is parsed, formatted
/// and bucketed.
///
/// WHY THIS EXISTS AT ALL. `flipdesk_expenses.spent_on` and
/// `mileage_trips.trip_date` are both Postgres `date` columns: a calendar day,
/// not a moment. Every bug this file prevents is the same bug — a day parsed in
/// one zone and formatted in another, so the value walks backwards by one day
/// each time it makes the round trip.
///
/// It has happened here twice already. US-1494 was expenses landing in the wrong
/// MONTH for anyone behind UTC, because parsing used a UTC midnight and
/// bucketing used `Calendar.current`. US-2339 is the Android half of the same
/// mistake and is still open: an expense date walks back a day on every
/// edit-and-sync cycle. A trip date is exactly the same shape of field, and
/// re-deriving the rule beside it would be inviting the third instance.
///
/// THE RULE. UTC, everywhere, for these columns only. A date-only value is
/// anchored at UTC midnight, rendered with a POSIX UTC formatter, and bucketed
/// with a UTC calendar. Real timestamps (`created_at` and friends) are not this
/// and must not come through here.
enum MoneyDate {

    /// The calendar every date-only bucketing uses.
    ///
    /// This is `ExpenseStore.bucketingCalendar`'s definition, moved here so
    /// trips and expenses share one instance rather than two that agree today.
    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC") ?? .current
        return c
    }()

    /// The wire formatter. `en_US_POSIX` so a device on a non-Gregorian
    /// calendar or a 12-hour locale still emits `2026-09-07` rather than
    /// something Postgres rejects or, worse, silently reads as another day.
    static let wireFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC") ?? .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// A `date` column's value, as the server wants it.
    static func iso(_ date: Date) -> String {
        wireFormatter.string(from: date)
    }

    /// A `YYYY-MM-DD` from the server, anchored at UTC midnight.
    ///
    /// Returns nil rather than a fallback: a caller that gets a date it cannot
    /// read should say so, not quietly substitute today and put a trip in the
    /// wrong tax year.
    static func parse(_ iso: String) -> Date? {
        wireFormatter.date(from: iso)
    }

    /// Today, anchored the same way every stored date is.
    ///
    /// NOT `Date()`, and — US-3230 — not `startOfDay(now)` either. The day a
    /// seller means is the day on THEIR wall clock, so the local calendar picks
    /// the day and the UTC anchor stores it.
    ///
    /// `startOfDay(now)` got that wrong in both directions. A seller in Sydney
    /// tapping "log a trip" at 9am on the 8th has a `Date()` whose UTC day is
    /// still the 7th, so the form opened on the 7th. A seller in Chicago
    /// tapping it at 9pm on the 9th has a UTC day of the 10th, so the picker
    /// showed the 9th (it renders in local time) while the wire carried the
    /// 10th. On 31 December that second one files the expense in the wrong tax
    /// year.
    static func today(now: Date = .now, localCalendar: Calendar = .current) -> Date {
        anchor(localDayOf: now, localCalendar: localCalendar)
    }

    /// UTC midnight of whatever day `date` falls on **in UTC**.
    ///
    /// Correct for a value that is already anchored; for a moment that came
    /// from a person or a clock, use ``anchor(localDayOf:localCalendar:)``.
    static func startOfDay(_ date: Date) -> Date {
        calendar.startOfDay(for: date)
    }

    // MARK: - Local day <-> stored day (US-3230)

    /// The LOCAL calendar day `date` falls on, re-anchored at UTC midnight —
    /// the shape a date-only column stores.
    ///
    /// This is the write half of the round trip. A `DatePicker` hands back a
    /// moment in the device's zone; only its year/month/day are meaningful, and
    /// they are read with the local calendar rather than reinterpreted in UTC.
    static func anchor(localDayOf date: Date, localCalendar: Calendar = .current) -> Date {
        let parts = localCalendar.dateComponents([.year, .month, .day], from: date)
        return calendar.date(from: parts) ?? startOfDay(date)
    }

    /// A stored UTC-anchored day, expressed as midnight LOCAL time on the same
    /// calendar day.
    ///
    /// This is the read half. A `DatePicker` renders whatever instant it is
    /// given in the device's zone, so handing it UTC midnight directly shows
    /// the previous day everywhere west of Greenwich.
    static func localMidnight(of stored: Date, localCalendar: Calendar = .current) -> Date {
        let parts = calendar.dateComponents([.year, .month, .day], from: stored)
        return localCalendar.date(from: parts) ?? stored
    }

    /// Binding adapter for a `DatePicker` over a date-only column: reads as
    /// local midnight so the picker shows the stored day, writes back the
    /// UTC-anchored value the column wants.
    ///
    ///     DatePicker("Date", selection: MoneyDate.dayPicker($spentOn), displayedComponents: .date)
    ///
    /// Without it the day on screen and the day on the wire disagree by one for
    /// most of the world for part of every day.
    static func dayPicker(
        _ stored: Binding<Date>,
        localCalendar: Calendar = .current
    ) -> Binding<Date> {
        Binding(
            get: { localMidnight(of: stored.wrappedValue, localCalendar: localCalendar) },
            set: { stored.wrappedValue = anchor(localDayOf: $0, localCalendar: localCalendar) }
        )
    }

    // MARK: - Month buckets (US-3302)

    /// UTC midnight of the first day of the LOCAL calendar month `date` falls in.
    ///
    /// The month-sized half of ``anchor(localDayOf:localCalendar:)``, and it
    /// splits the same way for the same reason. WHICH month a seller means is a
    /// question about their wall clock: at 8pm on 30 September in Chicago the
    /// month is September even though UTC has already rolled into October, and
    /// at 8am on 1 October in Tokyo it is October even though UTC has not. So
    /// the local calendar names the month and the UTC calendar anchors it.
    /// Reading `now` in UTC gets Tokyo wrong; anchoring the boundary in local
    /// time gets Chicago wrong (US-3302: a 1 September sale, anchored at
    /// 1 Sep 00:00Z, is 31 Aug 19:00 in Chicago and was counted in August).
    static func monthAnchor(localMonthOf date: Date, localCalendar: Calendar = .current) -> Date {
        let parts = localCalendar.dateComponents([.year, .month], from: date)
        return calendar.date(from: parts) ?? startOfMonth(date)
    }

    /// UTC midnight of the first of the month an ALREADY-ANCHORED day falls in.
    ///
    /// Correct for a stored `sale_date`/`spent_on`; for a moment that came from
    /// a clock, use ``monthAnchor(localMonthOf:localCalendar:)``.
    static func startOfMonth(_ anchored: Date) -> Date {
        let parts = calendar.dateComponents([.year, .month], from: anchored)
        return calendar.date(from: parts) ?? startOfDay(anchored)
    }

    /// `months` calendar months from an anchored month start, still anchored.
    /// Stepping a series with the local calendar would drag every boundary
    /// after the first across a DST change as well as across the zone offset.
    static func addingMonths(_ months: Int, to anchoredMonthStart: Date) -> Date {
        calendar.date(byAdding: .month, value: months, to: anchoredMonthStart) ?? anchoredMonthStart
    }

    /// "YYYY-M" identity of a month bucket, read in the zone it is anchored in.
    static func monthKey(_ anchoredMonthStart: Date) -> String {
        let parts = calendar.dateComponents([.year, .month], from: anchoredMonthStart)
        return "\(parts.year ?? 0)-\(parts.month ?? 0)"
    }

    /// Short month label ("Sep") for a bucket.
    ///
    /// US-3302 AC3: the label MUST come off the same calendar as the bucket. A
    /// bucket that starts at 1 Sep 00:00Z and a label formatter in
    /// America/Chicago render that same instant as "Aug", so the heading agreed
    /// with the wrong total and neither one looked wrong.
    static func monthLabel(_ anchoredMonthStart: Date) -> String {
        monthLabelFormatter.string(from: anchoredMonthStart)
    }

    private static let monthLabelFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC") ?? .current
        f.dateFormat = "MMM"
        return f
    }()

    // MARK: - Display (US-3302)

    /// A stored money day, rendered for a person in the zone it is anchored in.
    ///
    /// `Text(date, format: .dateTime.month().day().year())` renders whatever
    /// instant it is handed in the DEVICE's zone, so a sale dated 1 September
    /// printed as "Aug 31" for every seller west of UTC while the month total
    /// above it said September. Locale still comes from the device, so the
    /// month name and field order stay the reader's; only the zone is pinned.
    static func dayDisplay(_ anchored: Date) -> String {
        dayDisplayFormatter.string(from: anchored)
    }

    private static let dayDisplayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale.autoupdatingCurrent
        f.timeZone = TimeZone(identifier: "UTC") ?? .current
        f.dateStyle = .medium
        f.timeStyle = .none
        return f
    }()

    /// The calendar year a date-only value belongs to, in the same zone.
    ///
    /// Used to keep a trip out of the wrong tax year at a year boundary, which
    /// is the one day of the year the zone actually costs money.
    static func year(of date: Date) -> Int {
        calendar.component(.year, from: date)
    }
}
