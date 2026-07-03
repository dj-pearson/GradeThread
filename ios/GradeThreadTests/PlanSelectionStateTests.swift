import XCTest
@testable import GradeThread

/// US-804 + US-1523: the show-once gating for the post-signup plan-selection
/// step. Uses an isolated UserDefaults suite so it never touches the real app
/// domain. US-1523 keyed the pending flag to the SIGNUP EMAIL so a different
/// account signing in on the same device can never inherit the offer.
final class PlanSelectionStateTests: XCTestCase {

    private var suiteName = ""
    private var defaults: UserDefaults!
    private let userA = UUID()
    private let userB = UUID()
    private let emailA = "a@example.com"
    private let emailB = "b@example.com"

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
        s.resolvePending(userId: userA, email: emailA)
        XCTAssertFalse(s.shouldOffer(userId: userA))
    }

    // MARK: - Fresh signup happy path

    func test_signup_thenSignIn_offersOnce() {
        let s = state()
        s.markPendingEligibility(email: emailA)
        XCTAssertTrue(s.hasPendingEligibility)

        s.resolvePending(userId: userA, email: emailA)
        XCTAssertFalse(s.hasPendingEligibility, "pending is consumed once resolved")
        XCTAssertTrue(s.shouldOffer(userId: userA))

        // Showing the step records it; it must not offer again.
        s.markOffered(userId: userA)
        XCTAssertFalse(s.shouldOffer(userId: userA))
        XCTAssertTrue(s.hasOffered(userId: userA))
    }

    func test_emailMatch_isCaseAndWhitespaceInsensitive() {
        let s = state()
        s.markPendingEligibility(email: "  A@Example.COM ")
        s.resolvePending(userId: userA, email: "a@example.com")
        XCTAssertTrue(s.shouldOffer(userId: userA))
    }

    func test_offered_persistsAcrossInstances() {
        state().markPendingEligibility(email: emailA)
        state().resolvePending(userId: userA, email: emailA)
        state().markOffered(userId: userA)
        // A fresh struct over the same suite still sees the recorded flag.
        XCTAssertTrue(state().hasOffered(userId: userA))
        XCTAssertFalse(state().shouldOffer(userId: userA))
    }

    // MARK: - US-1523: the cross-account leak is closed

    func test_differentAccount_neverInheritsThePendingOffer() {
        let s = state()
        // A signs up but abandons before confirming; B (an existing account)
        // signs in on the same device.
        s.markPendingEligibility(email: emailA)
        s.resolvePending(userId: userB, email: emailB)
        XCTAssertFalse(s.shouldOffer(userId: userB), "B must not inherit A's signup offer")
        // The pending flag is PRESERVED for A…
        XCTAssertTrue(s.hasPendingEligibility)
        // …and A still gets it when they eventually sign in.
        s.resolvePending(userId: userA, email: emailA)
        XCTAssertTrue(s.shouldOffer(userId: userA))
        XCTAssertFalse(s.hasPendingEligibility)
    }

    func test_nilEmailAtSignIn_doesNotResolveSomeoneElsesPending() {
        let s = state()
        s.markPendingEligibility(email: emailA)
        s.resolvePending(userId: userB, email: nil)
        XCTAssertFalse(s.shouldOffer(userId: userB))
        XCTAssertTrue(s.hasPendingEligibility, "pending stays for the real signer-upper")
    }

    func test_legacyPendingWithoutEmail_isConsumedWithoutAttaching() {
        let s = state()
        // Pre-US-1523 install: pending=true but no stamped email.
        defaults.set(true, forKey: PlanSelectionState.pendingKey)
        s.resolvePending(userId: userA, email: emailA)
        XCTAssertFalse(s.shouldOffer(userId: userA), "legacy flags never attach — the safe direction")
        XCTAssertFalse(s.hasPendingEligibility, "…and are consumed so they can't linger")
    }

    // MARK: - US-1523: Apple direct-eligibility path

    func test_markEligible_offersThatUserDirectly() {
        let s = state()
        s.markEligible(userId: userA)
        XCTAssertTrue(s.shouldOffer(userId: userA))
        XCTAssertFalse(s.shouldOffer(userId: userB))
        XCTAssertFalse(s.hasPendingEligibility, "no device-level flag involved")
    }

    func test_markEligible_respectsAnExistingOfferedRecord() {
        let s = state()
        s.markEligible(userId: userA)
        s.markOffered(userId: userA)
        s.markEligible(userId: userA)
        XCTAssertFalse(s.shouldOffer(userId: userA))
    }

    // MARK: - Idempotency / one-shot

    func test_resolvePending_isOneShot() {
        let s = state()
        s.markPendingEligibility(email: emailA)
        s.resolvePending(userId: userA, email: emailA)
        s.markOffered(userId: userA)
        // A later stray pending+resolve for the same already-offered user must
        // not re-arm the offer.
        s.markPendingEligibility(email: emailA)
        s.resolvePending(userId: userA, email: emailA)
        XCTAssertFalse(s.shouldOffer(userId: userA))
    }

    // MARK: - Per-account isolation

    func test_offeringOneUser_doesNotAffectAnother() {
        let s = state()
        s.markPendingEligibility(email: emailA)
        s.resolvePending(userId: userA, email: emailA)
        s.markOffered(userId: userA)

        // A second fresh signup on the same device offers user B independently.
        s.markPendingEligibility(email: emailB)
        s.resolvePending(userId: userB, email: emailB)
        XCTAssertTrue(s.shouldOffer(userId: userB))
        XCTAssertFalse(s.shouldOffer(userId: userA))
    }
}
