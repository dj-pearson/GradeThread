import XCTest
@testable import GradeThread

/// Pure handle-validation rules (mirror of the edge `parseHandle`).
final class VerifiedHandleTests: XCTestCase {

    func test_valid_handles() {
        XCTAssertNil(VerifiedHandle.validationError("resale-rick"))
        XCTAssertNil(VerifiedHandle.validationError("abc"))
        XCTAssertNil(VerifiedHandle.validationError("a1b2c3"))
        XCTAssertTrue(VerifiedHandle.isValid("vintage-vault-99"))
    }

    func test_normalizes_trim_and_lowercase() {
        XCTAssertEqual(VerifiedHandle.normalize("  Resale-Rick  "), "resale-rick")
        XCTAssertNil(VerifiedHandle.validationError("  Resale-Rick  "))
    }

    func test_rejects_too_short_and_too_long() {
        XCTAssertNotNil(VerifiedHandle.validationError("ab"))
        XCTAssertNotNil(VerifiedHandle.validationError(String(repeating: "a", count: 31)))
    }

    func test_rejects_leading_trailing_hyphen_and_bad_chars() {
        XCTAssertNotNil(VerifiedHandle.validationError("-rick"))
        XCTAssertNotNil(VerifiedHandle.validationError("rick-"))
        XCTAssertNotNil(VerifiedHandle.validationError("rick_roll"))
        XCTAssertNotNil(VerifiedHandle.validationError("rick.roll"))
        XCTAssertNotNil(VerifiedHandle.validationError("rick roll"))
    }

    func test_rejects_reserved() {
        XCTAssertNotNil(VerifiedHandle.validationError("admin"))
        XCTAssertNotNil(VerifiedHandle.validationError("GradeThread"))
        XCTAssertNotNil(VerifiedHandle.validationError("verified"))
    }
}
