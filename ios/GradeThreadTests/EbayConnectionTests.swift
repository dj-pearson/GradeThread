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

    func test_callbackParse_errorMessage() {
        let url = URL(string: "com.gradethread.app://oauth/ebay?error=invalid_scope")!
        XCTAssertEqual(EbayConnectResult.from(callbackURL: url), .error(message: "invalid_scope"))
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
