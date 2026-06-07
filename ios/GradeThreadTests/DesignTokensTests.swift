import XCTest
@testable import GradeThread

/// US-652 — guards the shared spacing/radius scale and the `CardStylePadding`
/// mapping so the token layer stays internally consistent (no drift back to
/// mixed 12/14/16 radii). The chrome itself is a SwiftUI `ViewModifier`, which
/// is verified by the build + the call sites that adopt it.
final class DesignTokensTests: XCTestCase {

    func test_spacingScale_isMonotonic4ptStops() {
        let scale = [Spacing.xxs, Spacing.xs, Spacing.sm, Spacing.md,
                     Spacing.lg, Spacing.xl, Spacing.xxl]
        XCTAssertEqual(scale, [4, 8, 12, 16, 20, 24, 32])
        XCTAssertEqual(Spacing.md, 16, "16 is the canonical card/screen inset")
    }

    func test_cornerRadii_areUnified() {
        XCTAssertEqual(CornerRadius.card, 16)
        XCTAssertEqual(CornerRadius.control, 12)
        XCTAssertEqual(CornerRadius.chip, 9)
    }

    func test_cardPadding_valueMapping() {
        XCTAssertEqual(CardStylePadding.standard.value, 16)
        XCTAssertNil(CardStylePadding.flush.value, "flush adds no inner padding")
        XCTAssertEqual(CardStylePadding.inset(24).value, 24)
    }
}
