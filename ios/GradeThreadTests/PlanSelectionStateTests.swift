import XCTest
@testable import GradeThread

/// US-804: the show-once gating for the post-signup plan-selection step. Uses an
/// isolated UserDefaults suite so it never touches the real app domain.
final class PlanSelectionStateTests: XCTestCase {

    private var suiteName = ""
    private var defaults: UserDefaults!
    private let userA = UUID()
    private let userB = UUID()

    override func setUp() {
        super.setUp()
        suiteName = "test.planSelection.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private func state() -> PlanSelectionState { PlanSelectionState(defaults: defaults) }

    // MARK: - Defaults

    func test_freshState_offersNothing() {
        let s = state()
        XCTAssertFalse(s.hasPendingEligibility)
        XCTAssertFalse(s.shouldOffer(userId: userA))
        XCTAssertFalse(s.hasOffered(userId: userA))
    }

    // MARK: - Existing users are never prompted

    func test_existingUser_withoutSignup_isNeverOffered() {
        let s = state()
        // No pending signup → resolving does nothing → never eligible.
        s.resolvePending(userId: userA)
        XCTAssertFalse(s.shouldOffer(userId: userA))
    }

    // MARK: - Fresh signup happy path

    func test_signup_thenSignIn_offersOnce() {
        let s = state()
        s.markPendingEligibility()
        XCTAssertTrue(s.hasPendingEligibility)

        s.resolvePending(userId: userA)
        XCTAssertFalse(s.hasPendingEligibility, "pending is consumed once resolved")
        XCTAssertTrue(s.shouldOffer(userId: userA))

        // Showing the step records it; it must not offer again.
        s.markOffered(userId: userA)
        XCTAssertFalse(s.shouldOffer(userId: userA))
        XCTAssertTrue(s.hasOffered(userId: userA))
    }

    func test_offered_persistsAcrossInstances() {
        state().markPendingEligibility()
        state().resolvePending(userId: userA)
        state().markOffered(userId: userA)
        // A fresh struct over the same suite still sees the recorded flag.
        XCTAssertTrue(state().hasOffered(userId: userA))
        XCTAssertFalse(state().shouldOffer(userId: userA))
    }

    // MARK: - Idempotency / one-shot

    func test_resolvePending_isOneShot() {
        let s = state()
        s.markPendingEligibility()
        s.resolvePending(userId: userA)
        s.markOffered(userId: userA)
        // A later stray pending+resolve for the same already-offered user must
        // not re-arm the offer.
        s.markPendingEligibility()
        s.resolvePending(userId: userA)
        XCTAssertFalse(s.shouldOffer(userId: userA))
    }

    func test_resolvePending_doesNotReEligibleAnAlreadyOfferedUser() {
        let s = state()
        s.markPendingEligibility()
        s.resolvePending(userId: userA)
        s.markOffered(userId: userA)
        // Even with a pending flag set again, an offered user stays out of the set.
        s.markPendingEligibility()
        s.resolvePending(userId: userA)
        XCTAssertFalse(s.shouldOffer(userId: userA))
        XCTAssertFalse(s.hasPendingEligibility)
    }

    // MARK: - Per-account isolation

    func test_offeringOneUser_doesNotAffectAnother() {
        let s = state()
        s.markPendingEligibility()
        s.resolvePending(userId: userA)
        s.markOffered(userId: userA)

        // A second fresh signup on the same device offers user B independently.
        s.markPendingEligibility()
        s.resolvePending(userId: userB)
        XCTAssertTrue(s.shouldOffer(userId: userB))
        XCTAssertFalse(s.shouldOffer(userId: userA))
    }

    func test_pendingResolvesToWhicheverUserSignsIn() {
        let s = state()
        s.markPendingEligibility()
        // The pending signup attaches to the first signed-in id.
        s.resolvePending(userId: userB)
        XCTAssertTrue(s.shouldOffer(userId: userB))
        XCTAssertFalse(s.shouldOffer(userId: userA))
    }
}
