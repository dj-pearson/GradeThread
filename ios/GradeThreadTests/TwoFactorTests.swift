import XCTest
@testable import GradeThread

/// US-2671. Covers the two pieces of the 2FA flow that can be wrong without a
/// GoTrue container: the code-entry rules, and the challenge → verify retry
/// policy that exists because GoTrue binds a challenge to the IP that created it.
///
/// Deliberately NOT a test of `TwoFactorStore.challengeAndVerify` itself — that
/// one is two SDK calls and a call to the policy below. The policy is where a
/// wrong TOTP code could get silently retried, or a transient IPv6 flip could
/// be surfaced to the user as "wrong code", and both of those are real bugs a
/// simulator run would not reliably reproduce.
final class TwoFactorTests: XCTestCase {

    // MARK: - Code entry

    func testNormalizedKeepsDigitsOnly() {
        // Authenticator apps render "123 456" and a paste carries the space.
        XCTAssertEqual(TwoFactorCode.normalized("123 456"), "123456")
        XCTAssertEqual(TwoFactorCode.normalized("12-34-56"), "123456")
        XCTAssertEqual(TwoFactorCode.normalized(" 000111 "), "000111")
    }

    func testNormalizedTruncatesToSixDigits() {
        // A numeric keypad has no maxLength; without the cap a seventh keystroke
        // silently invalidates a code the user can see is right.
        XCTAssertEqual(TwoFactorCode.normalized("1234567"), "123456")
    }

    func testIsCompleteRequiresSixDigits() {
        XCTAssertFalse(TwoFactorCode.isComplete("12345"))
        XCTAssertFalse(TwoFactorCode.isComplete("abcdef"))
        XCTAssertTrue(TwoFactorCode.isComplete("123456"))
        XCTAssertTrue(TwoFactorCode.isComplete("123 456"))
    }

    // MARK: - IP-mismatch detection

    func testIpMismatchMatchesGoTrueErrorCode() {
        XCTAssertTrue(TwoFactorStore.isIpMismatch(StubError("mfa_ip_address_mismatch")))
    }

    func testIpMismatchMatchesProseForm() {
        XCTAssertTrue(TwoFactorStore.isIpMismatch(StubError("MFA IP Address mismatch")))
    }

    func testIpMismatchRejectsAWrongCode() {
        // The whole value of this predicate is that it says NO here — a wrong
        // code retried three times is three wasted round trips and, on the third,
        // a code that really has expired.
        XCTAssertFalse(TwoFactorStore.isIpMismatch(StubError("Invalid TOTP code entered")))
    }

    // MARK: - Retry policy

    func testVerifySucceedsOnFirstAttempt() async throws {
        var challenges = 0
        var verifies = 0
        try await TwoFactorStore.runChallengeVerify(
            code: "123456",
            retries: 3,
            challenge: { challenges += 1; return "ch-\(challenges)" },
            verify: { _, _ in verifies += 1 }
        )
        XCTAssertEqual(challenges, 1)
        XCTAssertEqual(verifies, 1)
    }

    func testMismatchRechallengesRatherThanReverifying() async throws {
        // The point of the retry is a FRESH challenge: re-verifying the same
        // challenge id would hit the same stamped IP and fail identically.
        var challengeIds: [String] = []
        var seen: [String] = []
        var attempts = 0
        try await TwoFactorStore.runChallengeVerify(
            code: "123456",
            retries: 3,
            challenge: {
                let id = "ch-\(challengeIds.count + 1)"
                challengeIds.append(id)
                return id
            },
            verify: { challengeId, _ in
                seen.append(challengeId)
                attempts += 1
                if attempts < 3 { throw StubError("mfa_ip_address_mismatch") }
            }
        )
        XCTAssertEqual(challengeIds.count, 3)
        XCTAssertEqual(seen, ["ch-1", "ch-2", "ch-3"])
    }

    func testWrongCodeIsSurfacedImmediately() async {
        var challenges = 0
        do {
            try await TwoFactorStore.runChallengeVerify(
                code: "000000",
                retries: 3,
                challenge: { challenges += 1; return "ch" },
                verify: { _, _ in throw StubError("Invalid TOTP code entered") }
            )
            XCTFail("a wrong code must not resolve")
        } catch {
            XCTAssertEqual(challenges, 1, "a wrong code must not be retried")
            XCTAssertTrue(TwoFactorStore.describe(error).contains("Invalid TOTP"))
        }
    }

    func testPersistentMismatchEndsWithTheActionableMessage() async {
        var challenges = 0
        do {
            try await TwoFactorStore.runChallengeVerify(
                code: "123456",
                retries: 2,
                challenge: { challenges += 1; return "ch" },
                verify: { _, _ in throw StubError("mfa_ip_address_mismatch") }
            )
            XCTFail("a persistent mismatch must not resolve")
        } catch {
            XCTAssertEqual(challenges, 3, "retries: 2 means one attempt plus two retries")
            guard case TwoFactorError.ipMismatch = error else {
                return XCTFail("expected the IP-mismatch error, got \(error)")
            }
            // GoTrue's own sentence tells the user nothing they can act on.
            XCTAssertTrue(TwoFactorError.ipMismatch.message.contains("Wi-Fi"))
        }
    }

    func testChallengeFailureIsTerminal() async {
        // A mismatch cannot surface on challenge — that call is what STAMPS the
        // IP — so retrying a failed challenge would loop on a real outage.
        var challenges = 0
        do {
            try await TwoFactorStore.runChallengeVerify(
                code: "123456",
                retries: 3,
                challenge: { challenges += 1; throw StubError("service unavailable") },
                verify: { _, _ in XCTFail("verify must not run after a failed challenge") }
            )
            XCTFail("a failed challenge must not resolve")
        } catch {
            XCTAssertEqual(challenges, 1)
        }
    }

    // MARK: - Presentation helpers

    @MainActor
    func testGroupedSecretIsReadableInFours() {
        XCTAssertEqual(
            TwoFactorSheet.groupedSecret("ABCDEFGHIJKLMNOP"),
            "ABCD EFGH IJKL MNOP"
        )
        // A length that is not a multiple of four must not drop the tail.
        XCTAssertEqual(TwoFactorSheet.groupedSecret("ABCDEF"), "ABCD EF")
        XCTAssertEqual(TwoFactorSheet.groupedSecret(""), "")
    }

    @MainActor
    func testQrRendersTheOtpauthUri() {
        let uri = "otpauth://totp/GradeThread:seller@example.com?secret=ABCDEFGHIJKLMNOP&issuer=GradeThread"
        let image = TwoFactorSheet.qrImage(from: uri)
        XCTAssertNotNil(image, "the enrollment screen is unusable without the QR")
        // The generator emits ~1px per module and the view scales by 10, so a
        // real payload cannot come back as a 1x1 placeholder.
        XCTAssertGreaterThan(image?.size.width ?? 0, 100)
    }

    // MARK: - Fixture

    private struct StubError: LocalizedError {
        let text: String
        init(_ text: String) { self.text = text }
        var errorDescription: String? { text }
    }
}
