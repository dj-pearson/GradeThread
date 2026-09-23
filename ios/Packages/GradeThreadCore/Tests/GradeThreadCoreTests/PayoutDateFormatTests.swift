import Foundation
import XCTest
@testable import GradeThreadCore

/// US-666 payout date display, asserted on Linux. The device-zone half (a full
/// timestamp keeps the device zone) stays in the app's
/// PayoutReconciliationTests, which changes `NSTimeZone.default`.
final class PayoutDateFormatTests: XCTestCase {

    func test_parse_handlesDateOnlyAndISO() {
        XCTAssertEqual(PayoutDateFormat.parse("2024-01-05"), Date(timeIntervalSince1970: 1_704_412_800))
        XCTAssertEqual(PayoutDateFormat.parse("2024-01-05T12:00:00Z"), Date(timeIntervalSince1970: 1_704_456_000))
        XCTAssertNil(PayoutDateFormat.parse(nil))
        XCTAssertNil(PayoutDateFormat.parse("not a date"))
    }

    func test_display_missingOrUnreadable_isADash() {
        XCTAssertEqual(PayoutDateFormat.display(nil), "\u{2014}")
        XCTAssertEqual(PayoutDateFormat.display("garbage"), "\u{2014}")
    }

    func test_display_dateOnly_rendersInUTC() {
        // A date-only payout renders through MoneyDate.dayDisplay, which is
        // pinned to UTC, so it cannot read one day early west of UTC.
        let anchored = MoneyDate.parse("2023-01-05")!
        XCTAssertEqual(PayoutDateFormat.display("2023-01-05"), MoneyDate.dayDisplay(anchored))
        let shown = PayoutDateFormat.display("2023-01-05")
        XCTAssertTrue(shown.contains("5"), shown)
        XCTAssertFalse(shown.contains("4"), shown)
    }

    func test_isDateOnly() {
        XCTAssertTrue(PayoutDateFormat.isDateOnly("2024-01-05"))
        XCTAssertFalse(PayoutDateFormat.isDateOnly("2024-01-05T12:00:00Z"))
        XCTAssertFalse(PayoutDateFormat.isDateOnly("2024-01-05 "))
    }
}
