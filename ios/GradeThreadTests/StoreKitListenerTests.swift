import XCTest
@testable import GradeThread

/// US-1144: the transaction listener's verify/revoke/finish decision is factored
/// into pure functions so the handshake's logic is unit-tested without StoreKit
/// (the live `process(_:)` still needs sandbox + a device, as documented).
final class StoreKitListenerTests: XCTestCase {

    func test_disposition_verifiedNotRevoked_isGrant() {
        XCTAssertEqual(
            StoreKitService.disposition(isVerified: true, isRevoked: false), .grant)
    }

    func test_disposition_verifiedRevoked_isRevoke() {
        XCTAssertEqual(
            StoreKitService.disposition(isVerified: true, isRevoked: true), .revoke)
    }

    func test_disposition_unverified_isDrop_evenIfRevoked() {
        XCTAssertEqual(
            StoreKitService.disposition(isVerified: false, isRevoked: false), .unverifiedDrop)
        XCTAssertEqual(
            StoreKitService.disposition(isVerified: false, isRevoked: true), .unverifiedDrop)
    }

    func test_shouldFinish_grant_onlyAfterServerConfirms() {
        XCTAssertTrue(StoreKitService.shouldFinish(.grant, reportSucceeded: true))
        // A server outage must NOT finish the transaction — it re-queues via
        // next-launch redelivery instead of being lost.
        XCTAssertFalse(StoreKitService.shouldFinish(.grant, reportSucceeded: false))
    }

    func test_shouldFinish_revoke_alwaysFinishes() {
        XCTAssertTrue(StoreKitService.shouldFinish(.revoke, reportSucceeded: true))
        XCTAssertTrue(StoreKitService.shouldFinish(.revoke, reportSucceeded: false))
    }

    func test_shouldFinish_unverified_neverFinishes() {
        XCTAssertFalse(StoreKitService.shouldFinish(.unverifiedDrop, reportSucceeded: true))
        XCTAssertFalse(StoreKitService.shouldFinish(.unverifiedDrop, reportSucceeded: false))
    }
}
