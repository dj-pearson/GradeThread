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

    /// US-1004: a non-English offline failure must still be classified as
    /// offline (and therefore queued) — classification is by NSURLErrorDomain
    /// code, NOT by matching English words in `localizedDescription`.
    func test_offline_nonEnglishLocalizedDescription_isOffline() {
        // Spanish "No hay conexión a Internet" — contains none of the English
        // substrings the old fallback matched ("offline"/"network"/"timed out").
        let err = NSError(
            domain: NSURLErrorDomain,
            code: NSURLErrorNotConnectedToInternet,
            userInfo: [NSLocalizedDescriptionKey: "No hay conexión a Internet"]
        )
        XCTAssertFalse(err.localizedDescription.lowercased().contains("network"))
        XCTAssertTrue(FriendlyErrorCopy.isOffline(err))
        XCTAssertEqual(FriendlyErrorCopy.kind(for: err), .offline)
    }

    /// US-1004: DNS / host-resolution failures (also reported in the device
    /// language) are connectivity problems and classify as offline.
    func test_offline_dnsLookupFailed_nonEnglish_isOffline() {
        let err = NSError(
            domain: NSURLErrorDomain,
            code: NSURLErrorDNSLookupFailed,
            userInfo: [NSLocalizedDescriptionKey: "DNS-Suche fehlgeschlagen"]
        )
        XCTAssertTrue(FriendlyErrorCopy.isOffline(err))
    }

    /// US-1004: the typed `EdgeAPIError.network` transport failure is offline,
    /// regardless of the embedded message.
    func test_offline_edgeAPINetworkError_isOffline() {
        let err = EdgeAPIError.network("la solicitud falló")
        XCTAssertTrue(FriendlyErrorCopy.isOffline(err))
        XCTAssertEqual(FriendlyErrorCopy.kind(for: err), .offline)
    }

    /// US-1004: a 4xx/validation rejection — even with a non-English message and
    /// the word "network" absent — must NOT be classified as offline, so the
    /// intake save surfaces it instead of silently queuing the create.
    func test_validationError_nonEnglish_isNotOffline() {
        let err = NSError(
            domain: "Postgrest",
            code: 400,
            userInfo: [NSLocalizedDescriptionKey: "El valor no es válido"]
        )
        XCTAssertFalse(FriendlyErrorCopy.isOffline(err))
        XCTAssertEqual(FriendlyErrorCopy.kind(for: err), .generic)
    }

    /// A typed `EdgeAPIError.badRequest` (4xx) is an app rejection, not offline.
    func test_edgeAPIBadRequest_isNotOffline() {
        let err = EdgeAPIError.badRequest(detail: "missing field")
        XCTAssertFalse(FriendlyErrorCopy.isOffline(err))
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

    // MARK: - Email-not-confirmed classification helper (US-810)

    /// US-810: `isEmailNotConfirmed` is the signal LoginView uses to swap in the
    /// resend-confirmation guidance. It must recognise GoTrue's variants of the
    /// "email not confirmed" rejection across SDK versions.
    func test_isEmailNotConfirmed_recognisesGoTrueVariants() {
        for message in [
            "Email not confirmed",
            "email_not_confirmed",
            "Please confirm your email address before signing in",
        ] {
            let err = goTrueError(message)
            XCTAssertTrue(
                FriendlyErrorCopy.isEmailNotConfirmed(err),
                "expected \(message) to classify as email-not-confirmed"
            )
        }
    }

    /// Other auth failures (and offline) must NOT be misread as unconfirmed —
    /// otherwise a wrong-password sign-in would surface a resend button.
    func test_isEmailNotConfirmed_falseForOtherKinds() {
        XCTAssertFalse(FriendlyErrorCopy.isEmailNotConfirmed(goTrueError("Invalid login credentials")))
        XCTAssertFalse(FriendlyErrorCopy.isEmailNotConfirmed(goTrueError("Email rate limit exceeded", code: 429)))
        XCTAssertFalse(FriendlyErrorCopy.isEmailNotConfirmed(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
        ))
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
