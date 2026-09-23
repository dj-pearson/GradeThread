import Foundation

// US-666 display helper for payout reconciliation dates, moved out of the app's
// PayoutReconciliationTypes.swift (mobile plan action 6) so it runs under
// `swift test` on Linux. `payout_date` is a Postgres `date`; `sale_date` is a
// timestamptz. The two must render differently, and this is where that lives.

public enum PayoutDateFormat {
    /// Parses a date-only (`YYYY-MM-DD`) or full ISO-8601 string.
    public static func parse(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let full = ISO8601DateFormatter()
        full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = full.date(from: raw) { return d }
        if let d = ISO8601DateFormatter().date(from: raw) { return d }
        let dateOnly = DateFormatter()
        dateOnly.locale = Locale(identifier: "en_US_POSIX")
        dateOnly.timeZone = TimeZone(identifier: "UTC")
        dateOnly.dateFormat = "yyyy-MM-dd"
        return dateOnly.date(from: raw)
    }

    /// Short medium-style display ("Jan 5, 2024"), or "—".
    ///
    /// A date-only value (`payout_date` is a Postgres `date`) is a calendar
    /// day, not an instant. `parse` anchors it at UTC midnight, so it has to
    /// be rendered in UTC too; in the device zone "Paid Jan 5" read "Jan 4"
    /// for every seller west of UTC. A full timestamp (`sale_date` is
    /// timestamptz) is a real instant and keeps the device zone.
    public static func display(_ raw: String?) -> String {
        guard let raw, let date = parse(raw) else { return "—" }
        if isDateOnly(raw) { return MoneyDate.dayDisplay(date) }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        return f.string(from: date)
    }

    /// True for a bare `YYYY-MM-DD` string with no time or zone part.
    public static func isDateOnly(_ raw: String) -> Bool {
        raw.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
    }
}
