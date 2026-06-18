import XCTest
@testable import GradeThread

/// US-1025: raw Supabase/URLError strings must never reach the auth/intake UI;
/// known failures map to specific friendly copy, the rest to a generic line.
final class FriendlyErrorCopyTests: XCTestCase {

    private func goTrueError(_ message: String, code: Int = 400) -> NSError {
        NSError(domain: "GoTrue", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }

    // MARK: - Offline classification

    func test_offline_urlErrorDomain_isOffline() {
        let err = NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
        XCTAssertTrue(FriendlyErrorCopy.isOffline(err))
        XCTAssertEqual(FriendlyErrorCopy.kind(for: err), .offline)
    }

    func test_offline_nestedUrlError_isOffline() {
        let underlying = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        let wrapper = NSError(
            domain: "Supabase",
            code: 1,
            userInfo: [NSUnderlyingErrorKey: underlying]
        )
        XCTAssertTrue(FriendlyErrorCopy.isOffline(wrapper))
    }

    func test_offline_authMessage_isOfflineSpecific() {
        let err = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)
        let copy = FriendlyErrorCopy.authMessage(for: err)
        XCTAssertTrue(copy.lowercased().contains("offline"))
    }

    // MARK: - Auth-specific cases

    func test_invalidCredentials_mapsToSpecificCopy() {
        let err = goTrueError("Invalid login credentials")
        XCTAssertEqual(FriendlyErrorCopy.kind(for: err), .invalidCredentials)
        XCTAssertEqual(
            FriendlyErrorCopy.authMessage(for: err),
            "The email or password you entered is incorrect."
        )
    }

    func test_emailNotConfirmed_mapsToSpecificCopy() {
        let err = goTrueError("Email not confirmed")
        XCTAssertEqual(FriendlyErrorCopy.kind(for: err), .emailNotConfirmed)
        XCTAssertTrue(FriendlyErrorCopy.authMessage(for: err).lowercased().contains("confirm"))
    }

    func test_rateLimited_mapsToSpecificCopy() {
        let err = goTrueError("Email rate limit exceeded", code: 429)
        XCTAssertEqual(FriendlyErrorCopy.kind(for: err), .rateLimited)
    }

    // MARK: - Generic fallback

    func test_unknownError_isGeneric_andNeverLeaksRawString() {
        let raw = "PostgrestError code 42501: new row violates row-level security policy"
        let err = NSError(domain: "Postgrest", code: 42501, userInfo: [NSLocalizedDescriptionKey: raw])
        XCTAssertEqual(FriendlyErrorCopy.kind(for: err), .generic)

        let authCopy = FriendlyErrorCopy.authMessage(for: err)
        XCTAssertFalse(authCopy.contains("row-level security"))
        XCTAssertEqual(authCopy, "Something went wrong. Please try again.")

        let actionCopy = FriendlyErrorCopy.actionMessage(for: err, fallback: "Couldn't save your item.")
        XCTAssertFalse(actionCopy.contains("row-level security"))
        XCTAssertEqual(actionCopy, "Couldn't save your item.")
    }

    // MARK: - rawDetail (Sentry payload, never UI)

    func test_rawDetail_flattensUnderlyingChain() {
        let underlying = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        let top = NSError(
            domain: "GoTrue",
            code: 0,
            userInfo: [
                NSLocalizedDescriptionKey: "request failed",
                NSUnderlyingErrorKey: underlying,
            ]
        )
        let detail = FriendlyErrorCopy.rawDetail(for: top)
        XCTAssertTrue(detail.contains("GoTrue"))
        XCTAssertTrue(detail.contains(NSURLErrorDomain))
        XCTAssertTrue(detail.contains("←"))
    }
}
