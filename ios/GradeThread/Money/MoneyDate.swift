import Foundation

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
    /// NOT `Date()`. A seller in Sydney tapping "log a trip" at 9am on the 8th
    /// has a `Date()` whose UTC day is still the 7th; anchoring through the
    /// same calendar keeps the default date on screen and the date sent to the
    /// server the same day.
    static func today(now: Date = .now) -> Date {
        startOfDay(now)
    }

    /// UTC midnight of whatever day `date` falls on.
    static func startOfDay(_ date: Date) -> Date {
        calendar.startOfDay(for: date)
    }

    /// The calendar year a date-only value belongs to, in the same zone.
    ///
    /// Used to keep a trip out of the wrong tax year at a year boundary, which
    /// is the one day of the year the zone actually costs money.
    static func year(of date: Date) -> Int {
        calendar.component(.year, from: date)
    }
}
