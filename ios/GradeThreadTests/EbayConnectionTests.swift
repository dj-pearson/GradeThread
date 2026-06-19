import XCTest
@testable import GradeThread

@MainActor
final class EbayConnectionTests: XCTestCase {

    // MARK: - ConsentResponse decoding

    func test_consentResponse_decodesSnakeCaseConsentUrl() throws {
        // EdgeAPI's shared decoder applies convertFromSnakeCase, which maps
        // `consent_url` → `consentUrl` (acronyms are lower-cased). We verify
        // with a JSONDecoder configured the same way.
        let json = #"""
        {"consent_url":"https://signin.ebay.com/authorize?client_id=abc"}
        """#
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(ConsentResponse.self, from: Data(json.utf8))
        XCTAssertTrue(response.consentUrl.contains("signin.ebay.com"))
    }

    // MARK: - RemoteMarketplaceConnection decoding

    func test_remoteConnection_decodesAllSnakeCaseColumns() throws {
        let json = #"""
        {
          "id": "conn-1",
          "marketplace": "ebay",
          "account_handle": "thrift_dan",
          "is_active": true,
          "last_synced_at": "2026-05-27T14:00:00.000Z",
          "refresh_error": null,
          "created_at": "2026-05-01T00:00:00.000Z",
          "updated_at": "2026-05-27T14:00:00.000Z"
        }
        """#
        let row = try JSONDecoder().decode(RemoteMarketplaceConnection.self, from: Data(json.utf8))
        XCTAssertEqual(row.id, "conn-1")
        XCTAssertEqual(row.accountHandle, "thrift_dan")
        XCTAssertTrue(row.isActive)
        XCTAssertNil(row.refreshError)
        XCTAssertEqual(row.lastSyncedAt, "2026-05-27T14:00:00.000Z")
    }

    func test_remoteConnection_decodesWithRefreshErrorAndNullSync() throws {
        let json = #"""
        {
          "id": "conn-2",
          "marketplace": "ebay",
          "account_handle": null,
          "is_active": false,
          "last_synced_at": null,
          "refresh_error": "invalid_grant",
          "created_at": "2026-05-01T00:00:00.000Z",
          "updated_at": "2026-05-15T00:00:00.000Z"
        }
        """#
        let row = try JSONDecoder().decode(RemoteMarketplaceConnection.self, from: Data(json.utf8))
        XCTAssertFalse(row.isActive)
        XCTAssertNil(row.accountHandle)
        XCTAssertNil(row.lastSyncedAt)
        XCTAssertEqual(row.refreshError, "invalid_grant")
    }

    // MARK: - EbayConnectResult callback parsing

    func test_callbackParse_cancelled() {
        let url = URL(string: "com.gradethread.app://oauth/ebay?ebay=cancelled")!
        XCTAssertEqual(EbayConnectResult.from(callbackURL: url), .cancelled)
    }

    func test_callbackParse_stateExpired() {
        let url = URL(string: "com.gradethread.app://oauth/ebay?ebay=state_expired")!
        XCTAssertEqual(EbayConnectResult.from(callbackURL: url), .stateExpired)
    }

    func test_callbackParse_connectedReturnsNil() {
        // Connected case signals to the caller "the server has already
        // written the row; go fetch it" — represented as nil rather
        // than .connected because the result enum doesn't carry the row.
        let url = URL(string: "com.gradethread.app://oauth/ebay?ebay=connected")!
        XCTAssertNil(EbayConnectResult.from(callbackURL: url))
    }

    // US-660: client-state CSRF nonce verification.
    func test_callbackParse_mismatchedState_rejected() {
        let url = URL(string: "com.gradethread.app://oauth/ebay?ebay=connected&client_state=forged")!
        XCTAssertEqual(
            EbayConnectResult.from(callbackURL: url, expectedState: "real-nonce"),
            .stateExpired
        )
    }

    func test_callbackParse_matchingState_passesThrough() {
        let url = URL(string: "com.gradethread.app://oauth/ebay?ebay=connected&client_state=real-nonce")!
        XCTAssertNil(EbayConnectResult.from(callbackURL: url, expectedState: "real-nonce"))
    }

    func test_callbackParse_absentState_isLenient() {
        // Server-side single-use state already validated the real handshake;
        // for callbacks that grant NO capability (cancel/error) an absent
        // client_state is not treated as an attack.
        let url = URL(string: "com.gradethread.app://oauth/ebay?ebay=cancelled")!
        XCTAssertEqual(EbayConnectResult.from(callbackURL: url, expectedState: "real-nonce"), .cancelled)
    }

    func test_callbackParse_connectedWithoutState_rejected() {
        // US-699: the SUCCESS path requires the nonce when one was expected —
        // a forged ?ebay=connected with no client_state must not claim success.
        let url = URL(string: "com.gradethread.app://oauth/ebay?ebay=connected")!
        XCTAssertEqual(
            EbayConnectResult.from(callbackURL: url, expectedState: "real-nonce"),
            .stateExpired)
    }

    func test_callbackParse_connectedNoExpectedState_stillLenient() {
        // When the caller didn't supply an expected nonce (legacy path), a
        // connected callback still resolves to nil → poll for the row.
        let url = URL(string: "com.gradethread.app://oauth/ebay?ebay=connected")!
        XCTAssertNil(EbayConnectResult.from(callbackURL: url))
    }

    func test_stateNonce_isRandomAndURLSafe() {
        let a = EbayConnectionService.generateStateNonce()
        let b = EbayConnectionService.generateStateNonce()
        XCTAssertNotEqual(a, b)
        XCTAssertFalse(a.contains("+"))
        XCTAssertFalse(a.contains("/"))
        XCTAssertFalse(a.contains("="))
        XCTAssertFalse(a.isEmpty)
    }

    // US-989: the `error` callback param is attacker-controllable on the legacy
    // custom-scheme path — known codes map to specific copy; the RAW code never
    // reaches the message.
    func test_callbackParse_knownErrorCode_mapsToSpecificCopy() {
        let url = URL(string: "com.gradethread.app://oauth/ebay?error=invalid_scope")!
        XCTAssertEqual(
            EbayConnectResult.from(callbackURL: url),
            .error(message: "eBay rejected the requested permissions. Please try again."))
    }

    func test_callbackParse_unknownErrorCode_isGeneric() {
        // An unrecognized code must NOT be echoed verbatim into the UI.
        let url = URL(string: "com.gradethread.app://oauth/ebay?error=totally_made_up")!
        XCTAssertEqual(
            EbayConnectResult.from(callbackURL: url),
            .error(message: EbayConnectResult.genericErrorMessage))
    }

    func test_callbackParse_oversizedErrorValue_isGeneric() {
        // Someone smuggling a long message through the param gets collapsed to
        // the generic copy — the raw string never renders.
        let injected = "<script>alert(1)</script>" + String(repeating: "A", count: 200)
        var comps = URLComponents(string: "com.gradethread.app://oauth/ebay")!
        comps.queryItems = [URLQueryItem(name: "error", value: injected)]
        let url = comps.url!
        guard case let .error(message) = EbayConnectResult.from(callbackURL: url) else {
            return XCTFail("expected an .error result")
        }
        XCTAssertEqual(message, EbayConnectResult.genericErrorMessage)
        XCTAssertFalse(message.contains("script"))
        XCTAssertFalse(message.contains("AAAA"))
    }

    func test_callbackParse_unknownEbayStatus_isGenericError() {
        // The edge can bounce `ebay=<code>` values the client doesn't model
        // (e.g. exchange_failed); they must surface friendly copy, never raw.
        let url = URL(string: "com.gradethread.app://oauth/ebay?ebay=exchange_failed")!
        XCTAssertEqual(
            EbayConnectResult.from(callbackURL: url),
            .error(message: "Couldn't finish connecting to eBay. Please try again."))
    }

    func test_sanitizedErrorMessage_accessDenied_readsAsCancelled() {
        XCTAssertEqual(
            EbayConnectResult.sanitizedErrorMessage(forCode: "ACCESS_DENIED"),
            "eBay sign-in was cancelled.")
    }

    func test_callbackParse_noKnownParams_returnsNil() {
        // No ?ebay= and no ?error= — caller falls through to a row
        // fetch and decides based on whether one materialized.
        let url = URL(string: "com.gradethread.app://oauth/ebay")!
        XCTAssertNil(EbayConnectResult.from(callbackURL: url))
    }

    // MARK: - US-661 Universal Link callback parsing

    // On iOS 17.4+ the edge bounces the callback to the https Universal Link
    // (https://gradethread.com/app/oauth/ebay) with the echoed client_state.
    // The same parser must handle the https form identically to the custom scheme.
    func test_universalLinkCallback_connected_withMatchingState() {
        let url = URL(string: "https://gradethread.com/app/oauth/ebay?client_state=real-nonce&ebay=connected")!
        XCTAssertNil(EbayConnectResult.from(callbackURL: url, expectedState: "real-nonce"))
    }

    func test_universalLinkCallback_cancelled() {
        let url = URL(string: "https://gradethread.com/app/oauth/ebay?client_state=real-nonce&ebay=cancelled")!
        XCTAssertEqual(
            EbayConnectResult.from(callbackURL: url, expectedState: "real-nonce"),
            .cancelled
        )
    }

    func test_universalLinkCallback_mismatchedState_rejected() {
        let url = URL(string: "https://gradethread.com/app/oauth/ebay?client_state=forged&ebay=connected")!
        XCTAssertEqual(
            EbayConnectResult.from(callbackURL: url, expectedState: "real-nonce"),
            .stateExpired
        )
    }

    func test_universalLink_constants_matchAASA() {
        // Host + path must line up with the AASA component (/app/oauth/*) and
        // the edge redirect target, or the in-app session never completes.
        XCTAssertEqual(EbayConnectionService.universalLinkHost, "gradethread.com")
        XCTAssertEqual(EbayConnectionService.universalLinkPath, "/app/oauth/ebay")
        XCTAssertEqual(EbayConnectionService.universalLinkRedirectPath, "/app/oauth/ebay")
    }

    // MARK: - US-989 consent URL host allowlist

    func test_consentURL_acceptsSigninEbay() throws {
        let url = try EbayConnectionService.validatedConsentURL(
            "https://signin.ebay.com/authorize?client_id=abc")
        XCTAssertEqual(url.host, "signin.ebay.com")
    }

    func test_consentURL_acceptsSandboxSubdomain() throws {
        let url = try EbayConnectionService.validatedConsentURL(
            "https://signin.sandbox.ebay.com/authorize?client_id=abc")
        XCTAssertEqual(url.host, "signin.sandbox.ebay.com")
    }

    func test_consentURL_acceptsApexEbay() throws {
        let url = try EbayConnectionService.validatedConsentURL("https://ebay.com/authorize")
        XCTAssertEqual(url.host, "ebay.com")
    }

    func test_consentURL_rejectsForeignHost() {
        XCTAssertThrowsError(
            try EbayConnectionService.validatedConsentURL("https://evil.example.com/phish"))
    }

    func test_consentURL_rejectsLookalikeHost() {
        // `evil-ebay.com` / `ebay.com.evil.com` must not satisfy the suffix check.
        XCTAssertThrowsError(
            try EbayConnectionService.validatedConsentURL("https://evil-ebay.com/phish"))
        XCTAssertThrowsError(
            try EbayConnectionService.validatedConsentURL("https://ebay.com.evil.com/phish"))
    }

    func test_consentURL_rejectsNonHTTPS() {
        // A well-formed URL that parses fine but isn't https must still be
        // rejected — URL(string:) success alone no longer gates the session.
        XCTAssertThrowsError(
            try EbayConnectionService.validatedConsentURL("http://signin.ebay.com/authorize"))
    }

    func test_consentURL_rejectsNonEbayCustomScheme() {
        XCTAssertThrowsError(
            try EbayConnectionService.validatedConsentURL("javascript://signin.ebay.com/alert"))
    }

    // MARK: - MarketplaceConnectionStore phase transitions

    func test_store_initial_phase_isLoading() {
        let store = MarketplaceConnectionStore(service: EbayConnectionService())
        XCTAssertEqual(store.phase, .loading)
        XCTAssertFalse(store.isConnecting)
    }

    // Most of MarketplaceConnectionStore exercises network IO — those
    // paths are smoke-tested against the real edge service in TestFlight.
    // The pure-state transition we *can* exercise is the
    // .reconnectRequired derivation: when fetchActiveConnection returns
    // nil but fetchLatestConnection returns a row with refresh_error,
    // the phase should land on .reconnectRequired. That logic lives in
    // refresh() and depends on the service — wire a mock in a future
    // pass when we add more service-layer tests.
}
