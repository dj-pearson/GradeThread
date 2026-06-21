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
        payoutNet: Double = 0
    ) -> WidgetSnapshot {
        WidgetSnapshot(
            generatedAt: .now,
            isSignedIn: signedIn,
            activeListings: 0,
            soldTodayCount: sold,
            soldTodayGross: gross,
            pendingPayoutCount: payoutCount,
            pendingPayoutNet: payoutNet
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
        XCTAssertEqual(SoldTodaySummary.currency(184), "$184")
        XCTAssertEqual(SoldTodaySummary.currency(184.5), "$184.50")
    }
}
