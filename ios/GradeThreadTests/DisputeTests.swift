import XCTest
@testable import GradeThread

/// Pure dispute-composition + eligibility-window logic (mirrors the web).
final class DisputeTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func iso(_ offsetDays: Double) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: now.addingTimeInterval(offsetDays * 86_400))
    }

    // MARK: - Compose

    func test_compose_nonOther_withDetails_joinsLabelAndDetails() {
        let result = DisputeComposer.compose(reason: .gradeTooLow, details: "  cuffs are fine  ")
        XCTAssertEqual(result, "Overall grade is too low — cuffs are fine")
    }

    func test_compose_nonOther_withoutDetails_isJustLabel() {
        XCTAssertEqual(DisputeComposer.compose(reason: .wrongCategory, details: "   "),
                       "Wrong garment type or category")
    }

    func test_compose_other_usesTrimmedDetailsOnly() {
        XCTAssertEqual(DisputeComposer.compose(reason: .other, details: "  the zipper works fine  "),
                       "the zipper works fine")
    }

    // MARK: - canSubmit

    func test_canSubmit_nonOther_alwaysTrue() {
        XCTAssertTrue(DisputeComposer.canSubmit(reason: .factorScore, details: ""))
    }

    func test_canSubmit_other_requiresMinLength() {
        XCTAssertFalse(DisputeComposer.canSubmit(reason: .other, details: "too short"))
        XCTAssertTrue(DisputeComposer.canSubmit(reason: .other, details: "this is a sufficiently detailed explanation"))
    }

    // MARK: - Window

    func test_window_recentGrade_isOpen() {
        XCTAssertTrue(GradeDisputeWindow.isOpen(createdAt: iso(-2), now: now))
    }

    func test_window_oldGrade_isClosed() {
        XCTAssertFalse(GradeDisputeWindow.isOpen(createdAt: iso(-10), now: now))
    }

    func test_window_missingOrUnparseable_isOpen() {
        XCTAssertTrue(GradeDisputeWindow.isOpen(createdAt: nil, now: now))
        XCTAssertTrue(GradeDisputeWindow.isOpen(createdAt: "not-a-date", now: now))
    }

    // MARK: - Reason parity

    func test_reasonRawValues_matchWeb() {
        // The stored value must equal the web's DISPUTE_REASONS value.
        XCTAssertEqual(DisputeReason.gradeTooLow.rawValue, "grade_too_low")
        XCTAssertEqual(DisputeReason.designAsDamage.rawValue, "design_as_damage")
        XCTAssertEqual(DisputeReason.other.rawValue, "other")
        XCTAssertEqual(DisputeReason.allCases.count, 7)
    }

    // MARK: - Status badge (US-819)

    func test_disputeStatus_knownValues_haveLabels() {
        XCTAssertEqual(DisputeStatusDisplay.label(for: "open"), "Disputed")
        XCTAssertEqual(DisputeStatusDisplay.label(for: "under_review"), "Under review")
        XCTAssertEqual(DisputeStatusDisplay.label(for: "resolved"), "Dispute resolved")
        XCTAssertEqual(DisputeStatusDisplay.label(for: "rejected"), "Dispute declined")
    }

    func test_disputeStatus_unknownOrNil_isNotDisputed() {
        XCTAssertNil(DisputeStatusDisplay.label(for: "frobnicated"))
        XCTAssertFalse(DisputeStatusDisplay.isDisputed(nil))
        XCTAssertFalse(DisputeStatusDisplay.isDisputed(""))
        XCTAssertFalse(DisputeStatusDisplay.isDisputed("frobnicated"))
    }

    func test_disputeStatus_knownValues_areDisputed() {
        for status in ["open", "under_review", "resolved", "rejected"] {
            XCTAssertTrue(DisputeStatusDisplay.isDisputed(status), "expected \(status) disputed")
        }
    }
}
