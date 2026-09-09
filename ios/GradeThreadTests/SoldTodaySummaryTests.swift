import XCTest
@testable import GradeThread

/// US-1134: the "What sold today" App Intent speaks a sentence built by the pure
/// ``SoldTodaySummary``. These pin its phrasing for the cases Siri hits most.
final class SoldTodaySummaryTests: XCTestCase {

    private func snapshot(
        signedIn: Bool = true,
        sold: Int = 0,
        gross: Double = 0,
        payoutCount: Int = 0,
        payoutNet: Double = 0,
        generatedAt: Date = .now
    ) -> WidgetSnapshot {
        WidgetSnapshot(
            generatedAt: generatedAt,
            isSignedIn: signedIn,
            activeListings: 0,
            soldTodayCount: sold,
            soldTodayGross: gross,
            pendingPayoutCount: payoutCount,
            pendingPayoutNet: payoutNet,
            // US-1161: pin USD so the phrasing assertions stay locale-independent.
            currencyCode: "USD"
        )
    }

    // MARK: - US-3228 day rollover

    /// The intent runs with `openAppWhenRun: false`, so asking Siri does not
    /// refresh the snapshot. Before this, a phone last opened at 10pm answered
    /// "You've sold 3 items today for $214" the next morning, spoken as fact.
    func test_staleSnapshot_refusesToStateTodaysSales_butKeepsPayout() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago") ?? .current
        let lastNight = calendar.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 22))!
        let breakfast = calendar.date(from: DateComponents(year: 2026, month: 9, day: 10, hour: 8))!

        let dialog = SoldTodaySummary.dialog(
            from: snapshot(sold: 3, gross: 214, payoutCount: 2, payoutNet: 180, generatedAt: lastNight),
            now: breakfast,
            calendar: calendar
        )

        XCTAssertEqual(
            dialog,
            "I don't have today's sales yet. Open GradeThread to refresh. $180 is waiting from 2 sales."
        )
        XCTAssertFalse(dialog.contains("3 items"))
        XCTAssertFalse(dialog.contains("214"))
    }

    /// Ten hours old but the SAME local day: still today's number, still spoken.
    func test_sameDaySnapshot_stillReportsTodaysSales() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago") ?? .current
        let morning = calendar.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 9))!
        let evening = calendar.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 19))!

        let dialog = SoldTodaySummary.dialog(
            from: snapshot(sold: 3, gross: 214, generatedAt: morning),
            now: evening,
            calendar: calendar
        )

        XCTAssertEqual(dialog, "You've sold 3 items today for $214. No payouts are waiting.")
    }

    func test_staleSnapshot_signedOutStillPromptsSignIn() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago") ?? .current
        let lastNight = calendar.date(from: DateComponents(year: 2026, month: 9, day: 9, hour: 22))!
        let breakfast = calendar.date(from: DateComponents(year: 2026, month: 9, day: 10, hour: 8))!

        XCTAssertEqual(
            SoldTodaySummary.dialog(
                from: snapshot(signedIn: false, generatedAt: lastNight),
                now: breakfast,
                calendar: calendar
            ),
            "Sign in to GradeThread to see what sold today."
        )
    }

    func test_nilSnapshot_promptsSignIn() {
        XCTAssertEqual(
            SoldTodaySummary.dialog(from: nil),
            "Sign in to GradeThread to see what sold today."
        )
    }

    func test_signedOut_promptsSignIn() {
        XCTAssertEqual(
            SoldTodaySummary.dialog(from: snapshot(signedIn: false)),
            "Sign in to GradeThread to see what sold today."
        )
    }

    func test_nothingSold_noPayout() {
        let dialog = SoldTodaySummary.dialog(from: snapshot(sold: 0))
        XCTAssertEqual(dialog, "Nothing's sold yet today. No payouts are waiting.")
    }

    func test_nothingSold_withPayout() {
        let dialog = SoldTodaySummary.dialog(
            from: snapshot(sold: 0, payoutCount: 2, payoutNet: 50))
        XCTAssertEqual(dialog, "Nothing's sold yet today. $50 is waiting from 2 sales.")
    }

    func test_oneSale_singularGrammar() {
        let dialog = SoldTodaySummary.dialog(
            from: snapshot(sold: 1, gross: 42, payoutCount: 1, payoutNet: 30))
        XCTAssertEqual(
            dialog,
            "You've sold 1 item today for $42. $30 is waiting from 1 sale."
        )
    }

    func test_multipleSales_pluralGrammar_andCents() {
        let dialog = SoldTodaySummary.dialog(
            from: snapshot(sold: 3, gross: 184.5, payoutCount: 5, payoutNet: 312.55))
        XCTAssertEqual(
            dialog,
            "You've sold 3 items today for $184.50. $312.55 is waiting from 5 sales."
        )
    }

    func test_currency_dropsZeroCents() {
        XCTAssertEqual(SoldTodaySummary.currency(184, code: "USD"), "$184")
        XCTAssertEqual(SoldTodaySummary.currency(184.5, code: "USD"), "$184.50")
    }
}
