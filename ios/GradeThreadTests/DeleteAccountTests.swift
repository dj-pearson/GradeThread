import XCTest
@testable import GradeThread

/// US-194 (account-deletion slice) — covers the typed-confirmation gate
/// that guards the destructive RPC. The RPC + sign-out path itself talks
/// to Supabase and isn't unit-tested here; the gate is the safety-
/// critical pure logic.
final class DeleteAccountTests: XCTestCase {

    func test_canDelete_exactPhrase_passes() {
        XCTAssertTrue(DeleteAccountSheet.canDelete(input: "delete"))
    }

    func test_canDelete_caseInsensitive_passes() {
        XCTAssertTrue(DeleteAccountSheet.canDelete(input: "Delete"))
        XCTAssertTrue(DeleteAccountSheet.canDelete(input: "DELETE"))
    }

    func test_canDelete_trimsSurroundingWhitespace() {
        XCTAssertTrue(DeleteAccountSheet.canDelete(input: "  delete  "))
        XCTAssertTrue(DeleteAccountSheet.canDelete(input: "delete\n"))
    }

    func test_canDelete_emptyOrPartial_fails() {
        XCTAssertFalse(DeleteAccountSheet.canDelete(input: ""))
        XCTAssertFalse(DeleteAccountSheet.canDelete(input: "del"))
        XCTAssertFalse(DeleteAccountSheet.canDelete(input: "deleteme"))
    }

    func test_canDelete_wrongWord_fails() {
        XCTAssertFalse(DeleteAccountSheet.canDelete(input: "remove"))
        XCTAssertFalse(DeleteAccountSheet.canDelete(input: "confirm"))
    }

    func test_canDelete_innerWhitespaceNotStripped_fails() {
        // Only leading/trailing whitespace is trimmed; "de lete" is not
        // the phrase.
        XCTAssertFalse(DeleteAccountSheet.canDelete(input: "de lete"))
    }

    func test_confirmationPhrase_isStable() {
        // The UI footer + the gate read the same constant; pin it so a
        // copy edit to one doesn't silently diverge from the other.
        XCTAssertEqual(DeleteAccountSheet.confirmationPhrase, "delete")
    }
}
