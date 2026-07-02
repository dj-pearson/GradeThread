import XCTest
import Supabase
@testable import GradeThread

/// US-1492: a "Forgot password?" email link exchange emits a `.passwordRecovery`
/// auth event with a live recovery session. Previously it was ignored, so the
/// user was silently signed in with their OLD password still valid and never
/// prompted to set a new one. The event must now raise
/// `passwordRecoveryRequested` so the shell auto-presents ChangePasswordSheet.
///
/// (The expired / cross-device link path — `handleAuthCallback` catching a failed
/// `session(from:)` and surfacing actionable copy — is covered at the
/// classification seam by `FriendlyErrorCopyTests.test_expiredLink_*`, since the
/// exchange itself calls the live SDK.)
@MainActor
final class AuthStoreRecoveryTests: XCTestCase {

    func test_passwordRecovery_raisesRequestFlag() {
        let store = AuthStore()
        XCTAssertFalse(store.passwordRecoveryRequested)

        store.apply(event: .passwordRecovery, session: nil)

        XCTAssertTrue(
            store.passwordRecoveryRequested,
            "the recovery event must flag the shell to present ChangePasswordSheet")
    }

    /// The recovery event must NOT itself flip the phase — the sheet is presented
    /// over the current surface, and a successful password update drives the phase
    /// via a subsequent `.userUpdated`.
    func test_passwordRecovery_leavesPhaseUnchanged() {
        let store = AuthStore()
        XCTAssertEqual(store.phase, .loading)

        store.apply(event: .passwordRecovery, session: nil)

        XCTAssertEqual(store.phase, .loading)
    }

    /// A sign-out event with no session moves to signedOut and does not spuriously
    /// request a password recovery.
    func test_signedOut_setsPhase_withoutRecoveryRequest() {
        let store = AuthStore()
        store.apply(event: .signedOut, session: nil)

        XCTAssertEqual(store.phase, .signedOut)
        XCTAssertFalse(store.passwordRecoveryRequested)
    }
}
