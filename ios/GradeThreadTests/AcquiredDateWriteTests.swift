import Foundation
import SwiftUI
import XCTest
@testable import GradeThread

/// US-3310 - the WRITE half of the anchored-day family.
///
/// US-3231, US-3302 and US-3306 swept COMPARISONS: a stored day read back
/// against the device's own calendar. This one is the opposite direction and
/// was invisible to that sweep. `inventory_items.acquired_date` is a Postgres
/// `date`, a calendar day and not a moment, and both iOS screens that write it
/// used to seed a raw `Date()` (carrying the current wall-clock time), bind it
/// to a raw `DatePicker`, then hand that moment to a UTC formatter. The
/// formatter names the day the moment falls on IN UTC, so a seller in Chicago
/// cataloging at 9pm on the 10th wrote the 11th, and a seller in Tokyo at 8am
/// on the 10th wrote the 9th. Nothing on screen ever disagreed, because the
/// rollups read the value back in UTC too - the number was simply wrong by
/// one, consistently, for most of the world for part of every day.
///
/// Every case below runs the same fixture through two device calendars on
/// opposite sides of UTC. Identical output is the property that matters.
@MainActor
final class AcquiredDateWriteTests: XCTestCase {

    /// UTC-5/-6. West of UTC: an evening here is already tomorrow in UTC.
    private let chicago: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago") ?? .current
        return c
    }()

    /// UTC+9. East of UTC: a morning here is still yesterday in UTC.
    private let tokyo: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Tokyo") ?? .current
        return c
    }()

    private var devices: [(name: String, calendar: Calendar)] {
        [("Chicago", chicago), ("Tokyo", tokyo)]
    }

    /// What a `DatePicker` in `.date` mode hands back when the seller taps a
    /// day: midnight on that day, in the DEVICE's own zone.
    private func picked(
        year: Int, month: Int, day: Int, in calendar: Calendar
    ) -> Date {
        calendar.date(
            from: DateComponents(year: year, month: month, day: day)
        ) ?? .distantPast
    }

    /// A wall-clock moment on a device, for the seed cases.
    private func moment(
        year: Int, month: Int, day: Int, hour: Int, in calendar: Calendar
    ) -> Date {
        calendar.date(
            from: DateComponents(year: year, month: month, day: day, hour: hour)
        ) ?? .distantPast
    }

    /// The day `date` falls on, on THIS device. What the seller reads.
    private func localDay(_ date: Date, in calendar: Calendar) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    // MARK: - AC3: the day picked is the day written

    func test_pickedDay_isWrittenAsThatDay_inChicagoAndTokyo() {
        for device in devices {
            var stored = Date.distantPast
            let picker = MoneyDate.dayPicker(
                Binding(get: { stored }, set: { stored = $0 }),
                localCalendar: device.calendar
            )

            picker.wrappedValue = picked(
                year: 2026, month: 9, day: 10, in: device.calendar
            )

            XCTAssertEqual(
                ItemCanvasView.acquiredDateString(stored), "2026-09-10",
                "\(device.name) wrote a different day than the seller picked"
            )
        }
    }

    /// The other half of the round trip: a stored day renders in the picker as
    /// the same day, rather than as the one before it everywhere west of UTC.
    func test_storedDay_showsAsThatDayInThePicker_inChicagoAndTokyo() {
        for device in devices {
            var stored = MoneyDate.parse("2026-09-10") ?? .distantPast
            let picker = MoneyDate.dayPicker(
                Binding(get: { stored }, set: { stored = $0 }),
                localCalendar: device.calendar
            )

            XCTAssertEqual(
                localDay(picker.wrappedValue, in: device.calendar), "2026-09-10",
                "\(device.name) showed a different day than the one stored"
            )
        }
    }

    /// Re-picking the day already on screen must not move it. This is the
    /// edit-and-save cycle that walked the value back one day at a time.
    func test_pickerRoundTrip_isStable_inChicagoAndTokyo() {
        for device in devices {
            var stored = MoneyDate.parse("2026-09-10") ?? .distantPast
            let picker = MoneyDate.dayPicker(
                Binding(get: { stored }, set: { stored = $0 }),
                localCalendar: device.calendar
            )

            for _ in 0..<5 { picker.wrappedValue = picker.wrappedValue }

            XCTAssertEqual(
                ItemCanvasView.acquiredDateString(stored), "2026-09-10",
                "\(device.name) drifted across repeated edits"
            )
        }
    }

    func test_noAcquiredDate_writesNoValue() {
        XCTAssertNil(ItemCanvasView.acquiredDateString(nil))
    }

    // MARK: - AC1: the seed

    /// The toggle and the intake form seed "today". Today is a question about
    /// the seller's wall clock, and the two hours of the day where UTC
    /// disagrees are exactly the hours a reseller catalogs in.
    func test_seededToday_isTheSellersDay_notTheUtcDay() {
        let chicagoEvening = moment(
            year: 2026, month: 9, day: 10, hour: 21, in: chicago
        )
        XCTAssertEqual(
            MoneyDate.iso(MoneyDate.today(now: chicagoEvening, localCalendar: chicago)),
            "2026-09-10"
        )

        let tokyoMorning = moment(
            year: 2026, month: 9, day: 10, hour: 8, in: tokyo
        )
        XCTAssertEqual(
            MoneyDate.iso(MoneyDate.today(now: tokyoMorning, localCalendar: tokyo)),
            "2026-09-10"
        )
    }

    /// The witness for why the two cases above are worth running: the same two
    /// moments, through the UTC formatter they used to go through, name the
    /// days either side of the one the seller was looking at.
    func test_theOldWriteNamedTheWrongDay() {
        let utc = DateFormatter()
        utc.locale = Locale(identifier: "en_US_POSIX")
        utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        utc.dateFormat = "yyyy-MM-dd"

        XCTAssertEqual(
            utc.string(from: moment(year: 2026, month: 9, day: 10, hour: 21, in: chicago)),
            "2026-09-11"
        )
        XCTAssertEqual(
            utc.string(from: moment(year: 2026, month: 9, day: 10, hour: 8, in: tokyo)),
            "2026-09-09"
        )
    }

    /// The manual intake form is the second writer of the same column, and it
    /// seeded `.now` with a time on it.
    func test_intakeFormSeedsAnAnchoredDay() {
        let form = IntakeFormState()
        XCTAssertEqual(
            form.purchaseDate, MoneyDate.startOfDay(form.purchaseDate),
            "purchaseDate carries a time, so a UTC render can name another day"
        )

        form.resetAll()
        XCTAssertEqual(form.purchaseDate, MoneyDate.startOfDay(form.purchaseDate))
    }

    // MARK: - AC4: the other date-only writes

    /// `sales.sale_date` is the same shape of column, written from a raw picker
    /// moment. It was already right - a device-local formatter names the local
    /// day - but it was a second private copy of the rule, and this pins the
    /// behavior now that it goes through `MoneyDate`.
    func test_saleDay_isTheSellersDay_inChicagoAndTokyo() {
        XCTAssertEqual(
            SaleRecorder.dayString(
                moment(year: 2026, month: 9, day: 10, hour: 21, in: chicago),
                localCalendar: chicago
            ),
            "2026-09-10"
        )
        XCTAssertEqual(
            SaleRecorder.dayString(
                moment(year: 2026, month: 9, day: 10, hour: 8, in: tokyo),
                localCalendar: tokyo
            ),
            "2026-09-10"
        )
    }

    /// The analytics window start is an already-anchored day, so rendering it
    /// must be zone-free. Pinned because it stopped being a private formatter.
    func test_analyticsWindowStart_rendersTheAnchoredDay() {
        let anchored = MoneyDate.parse("2025-10-09") ?? .distantPast
        XCTAssertEqual(ReturnReductionStore.isoDay(anchored), "2025-10-09")
    }
}
