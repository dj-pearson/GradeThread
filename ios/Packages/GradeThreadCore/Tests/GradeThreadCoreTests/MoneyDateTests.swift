import Foundation
import XCTest
@testable import GradeThreadCore

/// The date-only money rule (US-3014, US-3230, US-3302), asserted on Linux.
///
/// These cases also live in the app's MileageTests / MoneyMonthBucketTests,
/// which only a macOS runner can execute. Here they run under `swift test` in
/// the Core package lane, so a zone regression is caught without a Mac.
final class MoneyDateTests: XCTestCase {

    private func calendar(_ zone: String) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: zone)!
        return c
    }

    func test_wireRoundTrip_isStableOverManyEdits() {
        // US-2339 was this value walking back one day per edit cycle.
        var date = MoneyDate.parse("2026-03-01")!
        for _ in 0..<10 {
            date = MoneyDate.parse(MoneyDate.iso(date))!
        }
        XCTAssertEqual(MoneyDate.iso(date), "2026-03-01")
    }

    func test_parse_anchorsAtUTCMidnight() {
        // 2026-09-09T00:00:00Z
        XCTAssertEqual(MoneyDate.parse("2026-09-09"), Date(timeIntervalSince1970: 1_788_912_000))
    }

    func test_parse_refusesAnUnreadableDate() {
        XCTAssertNil(MoneyDate.parse("not a date"))
        XCTAssertNil(MoneyDate.parse("01/02/2026"))
    }

    func test_year_holdsAtTheBoundary() {
        XCTAssertEqual(MoneyDate.year(of: MoneyDate.parse("2027-01-01")!), 2027)
        XCTAssertEqual(MoneyDate.year(of: MoneyDate.parse("2026-12-31")!), 2026)
    }

    func test_today_isTheSellersLocalDay_onBothSidesOfUTC() {
        let chicago = calendar("America/Chicago")
        let ninePM = chicago.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 21))!
        XCTAssertEqual(MoneyDate.iso(MoneyDate.today(now: ninePM, localCalendar: chicago)), "2026-09-09")

        let sydney = calendar("Australia/Sydney")
        let nineAM = sydney.date(from: DateComponents(year: 2026, month: 9, day: 8, hour: 9))!
        XCTAssertEqual(MoneyDate.iso(MoneyDate.today(now: nineAM, localCalendar: sydney)), "2026-09-08")
    }

    func test_localMidnightAndAnchor_roundTripInEveryZone() {
        for zone in ["America/Chicago", "Australia/Sydney", "UTC", "Asia/Kolkata"] {
            let local = calendar(zone)
            let stored = MoneyDate.parse("2026-09-09")!
            let shown = MoneyDate.localMidnight(of: stored, localCalendar: local)
            XCTAssertEqual(local.component(.day, from: shown), 9, "picker showed the wrong day in \(zone)")
            let back = MoneyDate.anchor(localDayOf: shown, localCalendar: local)
            XCTAssertEqual(MoneyDate.iso(back), "2026-09-09", "round trip lost a day in \(zone)")
        }
    }

    func test_monthAnchor_localCalendarNamesTheMonth() {
        // 8pm on 30 September in Chicago is already October in UTC.
        let chicago = calendar("America/Chicago")
        let lateSep = chicago.date(from: DateComponents(year: 2026, month: 9, day: 30, hour: 20))!
        let month = MoneyDate.monthAnchor(localMonthOf: lateSep, localCalendar: chicago)
        XCTAssertEqual(MoneyDate.iso(month), "2026-09-01")
        XCTAssertEqual(MoneyDate.monthKey(month), "2026-9")
        XCTAssertEqual(MoneyDate.monthLabel(month), "Sep")
        XCTAssertEqual(MoneyDate.iso(MoneyDate.addingMonths(1, to: month)), "2026-10-01")
    }

    func test_startOfMonth_ofAnAnchoredFirst_staysInThatMonth() {
        // US-3302: 1 Sep 00:00Z must not be read as 31 Aug.
        let first = MoneyDate.parse("2026-09-01")!
        XCTAssertEqual(MoneyDate.iso(MoneyDate.startOfMonth(first)), "2026-09-01")
        XCTAssertEqual(MoneyDate.monthLabel(first), "Sep")
    }
}
