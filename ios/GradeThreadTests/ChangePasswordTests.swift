import XCTest
@testable import GradeThread

/// US-818 — covers the pure validation gate for the in-app change-password
/// form. The `updatePassword` call itself talks to Supabase and isn't unit-
/// tested here; the length/match rule is the safety-critical pure logic.
final class ChangePasswordTests: XCTestCase {

    func test_validate_emptyInitialState_noHint() {
        XCTAssertNil(ChangePasswordSheet.validate(newPassword: "", confirm: ""))
    }

    func test_validate_tooShort_returnsLengthHint() {
        let hint = ChangePasswordSheet.validate(newPassword: "abc", confirm: "")
        XCTAssertEqual(hint, "Password must be at least 6 characters.")
    }

    func test_validate_longEnoughButConfirmEmpty_noHintYet() {
        // Don't nag about a mismatch before the user has typed the confirm.
        XCTAssertNil(ChangePasswordSheet.validate(newPassword: "secret123", confirm: ""))
    }

    func test_validate_mismatch_returnsMismatchHint() {
        let hint = ChangePasswordSheet.validate(newPassword: "secret123", confirm: "secret124")
        XCTAssertEqual(hint, "Passwords don't match.")
    }

    func test_validate_validMatchingPair_noHint() {
        XCTAssertNil(ChangePasswordSheet.validate(newPassword: "secret123", confirm: "secret123"))
    }

    func test_validate_exactlyMinimumLength_passes() {
        XCTAssertNil(ChangePasswordSheet.validate(newPassword: "123456", confirm: "123456"))
    }

    func test_minimumLength_matchesSignupFloor() {
        // Mirrors the LoginView signup minimum (GoTrue default).
        XCTAssertEqual(ChangePasswordSheet.minimumLength, 6)
    }
}
