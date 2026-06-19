import XCTest
@testable import GradeThread

/// US-988: strict scheme+host+path matching for the auth-callback deep link.
/// On iOS 17.4+ (`allowCustomScheme: false`) only the https Universal Link we
/// own is accepted; the claimable custom scheme is ignored. Below 17.4
/// (`allowCustomScheme: true`) the legacy custom scheme is still honored.
final class AuthCallbackMatchingTests: XCTestCase {
    private func match(_ string: String, allowCustomScheme: Bool) -> Bool {
        guard let url = URL(string: string) else {
            XCTFail("Could not build URL from \(string)")
            return false
        }
        return AuthStore.isAcceptableAuthCallback(url: url, allowCustomScheme: allowCustomScheme)
    }

    // MARK: - iOS 17.4+ (custom scheme disallowed)

    func test_modernOS_rejectsCustomScheme() {
        XCTAssertFalse(
            match("com.gradethread.app://auth-callback?code=abc123", allowCustomScheme: false),
            "On 17.4+ a claimable custom-scheme callback must be ignored."
        )
    }

    func test_modernOS_acceptsUniversalLink() {
        XCTAssertTrue(match("https://gradethread.com/app/auth-callback", allowCustomScheme: false))
        XCTAssertTrue(match("https://gradethread.com/app/auth-callback?code=abc123", allowCustomScheme: false))
    }

    func test_modernOS_rejectsLookAlikeHosts() {
        XCTAssertFalse(
            match("https://gradethread.com.evil.com/app/auth-callback", allowCustomScheme: false),
            "A suffix look-alike host must not match the exact host equality."
        )
        XCTAssertFalse(match("https://evilgradethread.com/app/auth-callback", allowCustomScheme: false))
        XCTAssertFalse(match("https://notgradethread.com/app/auth-callback?code=x", allowCustomScheme: false))
    }

    func test_modernOS_rejectsWrongPath() {
        XCTAssertFalse(match("https://gradethread.com/auth-callback", allowCustomScheme: false))
        XCTAssertFalse(match("https://gradethread.com/app/other", allowCustomScheme: false))
    }

    // MARK: - iOS < 17.4 (custom scheme allowed)

    func test_legacyOS_acceptsCustomScheme() {
        XCTAssertTrue(
            match("com.gradethread.app://auth-callback?code=abc123", allowCustomScheme: true),
            "Below 17.4 the custom scheme remains the redirect target."
        )
    }

    func test_legacyOS_stillAcceptsUniversalLink() {
        XCTAssertTrue(match("https://gradethread.com/app/auth-callback?code=abc123", allowCustomScheme: true))
    }

    func test_legacyOS_rejectsForeignCustomScheme() {
        XCTAssertFalse(
            match("com.evil.app://auth-callback", allowCustomScheme: true),
            "Only our own custom scheme should match, even below 17.4."
        )
        XCTAssertFalse(match("com.gradethread.app://not-a-callback", allowCustomScheme: true))
    }

    // MARK: - Non-auth URLs are always ignored

    func test_unrelatedURLsRejected() {
        XCTAssertFalse(match("https://gradethread.com/dashboard", allowCustomScheme: false))
        XCTAssertFalse(match("https://example.com/app/auth-callback", allowCustomScheme: true))
        XCTAssertFalse(match("http://gradethread.com/app/auth-callback", allowCustomScheme: false))
    }
}
