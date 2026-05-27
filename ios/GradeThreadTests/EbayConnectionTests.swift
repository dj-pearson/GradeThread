import XCTest
@testable import GradeThread

@MainActor
final class EbayConnectionTests: XCTestCase {

    // MARK: - ConsentResponse decoding

    func test_consentResponse_decodesSnakeCaseConsentUrl() throws {
        // EdgeAPI's shared decoder applies convertFromSnakeCase, so the
        // wire's `consent_url` lands on `consentURL` automatically. We
        // verify with a JSONDecoder configured the same way.
        let json = #"""
        {"consent_url":"https://signin.ebay.com/authorize?client_id=abc"}
        """#
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(ConsentResponse.self, from: Data(json.utf8))
        XCTAssertTrue(response.consentURL.contains("signin.ebay.com"))
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
