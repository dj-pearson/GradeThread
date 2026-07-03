import XCTest
@testable import GradeThread

/// US-1523: classification of auth-session fetch errors. A network-shaped
/// failure (URLError anywhere in the underlying chain) is `.transient` — the
/// request must retry, never go out unauthenticated, never read as signed-out.
/// Anything else is `.noSession`; the EdgeAPI server-401 + forced-refresh path
/// remains the authoritative expiry signal.
final class AccessTokenClassificationTests: XCTestCase {

    private func isTransient(_ result: SupabaseShared.AccessTokenResult) -> Bool {
        if case .transient = result { return true }
        return false
    }

    private func isNoSession(_ result: SupabaseShared.AccessTokenResult) -> Bool {
        if case .noSession = result { return true }
        return false
    }

    func test_urlErrors_classifyTransient() {
        for code in [
            URLError.timedOut,
            URLError.notConnectedToInternet,
            URLError.networkConnectionLost,
            URLError.cannotFindHost,
            URLError.cannotConnectToHost,
            URLError.dnsLookupFailed,
        ] {
            let result = SupabaseShared.classifyTokenError(URLError(code))
            XCTAssertTrue(isTransient(result), "URLError \(code.rawValue) must be transient")
        }
    }

    func test_wrappedURLError_isFoundThroughTheUnderlyingChain() {
        // SDKs routinely wrap transport errors: outer(custom) → mid → URLError.
        let url = URLError(.timedOut) as NSError
        let mid = NSError(domain: "auth.wrapper", code: 1,
                          userInfo: [NSUnderlyingErrorKey: url])
        let outer = NSError(domain: "supabase.sdk", code: 42,
                            userInfo: [NSUnderlyingErrorKey: mid])
        XCTAssertTrue(isTransient(SupabaseShared.classifyTokenError(outer)))
    }

    func test_nonNetworkErrors_classifyNoSession() {
        struct SessionMissing: Error {}
        XCTAssertTrue(isNoSession(SupabaseShared.classifyTokenError(SessionMissing())))
        let plain = NSError(domain: "auth.gotrue", code: 401, userInfo: [:])
        XCTAssertTrue(isNoSession(SupabaseShared.classifyTokenError(plain)))
    }

    func test_selfReferentialUnderlyingChain_terminates() {
        // Defensive: the walker is hop-bounded, so a pathological chain can't
        // spin. (A truly cyclic NSError chain isn't constructible without
        // subclassing, so bound-checking with a deep linear chain suffices.)
        var err = NSError(domain: "leaf", code: 0, userInfo: [:])
        for i in 0..<20 {
            err = NSError(domain: "wrap\(i)", code: i,
                          userInfo: [NSUnderlyingErrorKey: err])
        }
        XCTAssertTrue(isNoSession(SupabaseShared.classifyTokenError(err)))
    }
}
