import XCTest
@testable import GradeThread

/// US-2503 AC2 screen 3: the buyer trust score.
@MainActor
final class BuyerTrustScoreStoreTests: XCTestCase {

    private func entitlements(trustScore unlocked: Bool) -> BuyerEntitlementsStore {
        let store = BuyerEntitlementsStore(fetch: {
            BuyerEntitlements(
                plan: unlocked ? "connoisseur" : "free",
                gateFlags: ["trustScore": unlocked],
                allowances: .free)
        })
        return store
    }

    private func reputation(
        score: Int = 150,
        level: Int = 2,
        levelName: String = "Established",
        eventCount: Int = 9,
        perks: BuyerReputation.Perks = BuyerReputation.Perks(
            guaranteeWindowBonusDays: 14,
            priorityClaimHandling: true,
            earlyDropAccess: false,
            rewardMultiplier: 1.1),
        next: BuyerReputation.NextLevel? = BuyerReputation.NextLevel(
            levelName: "Connoisseur", pointsAway: 150)
    ) -> BuyerReputation {
        BuyerReputation(
            score: score,
            level: level,
            levelName: levelName,
            eventCount: eventCount,
            computedAt: nil,
            perks: perks,
            next: next)
    }

    func test_anUnlockedPlanLoadsTheResolvedLevel() async {
        let ent = entitlements(trustScore: true)
        await ent.load()
        let store = BuyerTrustScoreStore(fetch: { self.reputation() })

        await store.load(entitlements: ent)

        XCTAssertEqual(store.phase, .ready(reputation()))
    }

    // "Upgrade to see this" and "we could not load this" ask the buyer for two
    // completely different things, so they are two states, never one.
    func test_aLockedPlanIsLockedRatherThanFailed() async {
        let ent = entitlements(trustScore: false)
        await ent.load()
        let calls = CallCounter()
        let store = BuyerTrustScoreStore(fetch: {
            calls.count += 1
            return self.reputation()
        })

        await store.load(entitlements: ent)

        XCTAssertEqual(store.phase, .locked)
        XCTAssertEqual(calls.count, 0, "a locked plan must not spend a request finding out")
    }

    func test_aFailedReadIsFailedRatherThanAnEmptyScore() async {
        // Rendering zero points to a buyer who has earned some is worse than an
        // error: it reads as a reset of something they built up.
        let ent = entitlements(trustScore: true)
        await ent.load()
        let store = BuyerTrustScoreStore(fetch: { throw URLError(.timedOut) })

        await store.load(entitlements: ent)

        guard case .failed = store.phase else {
            return XCTFail("expected .failed, got \(store.phase)")
        }
    }

    // A buyer with no score row is level 0 "New" — an ordinary starting state,
    // not an error and not an empty state. The edge resolves it that way; this
    // pins that the client renders it rather than treating it as nothing.
    func test_aBrandNewBuyerRendersLevelZeroNotAnError() async {
        let ent = entitlements(trustScore: true)
        await ent.load()
        let store = BuyerTrustScoreStore(fetch: { BuyerReputation.new })

        await store.load(entitlements: ent)

        XCTAssertEqual(store.phase, .ready(.new))
        XCTAssertFalse(BuyerTrustScoreView.hasAnyPerk(BuyerReputation.new.perks))
    }

    // The multiplier is an implementation detail. What the buyer gets is the
    // extra, and 1.25 is not "1.25 times" to anybody outside this codebase.
    func test_theRewardMultiplierReadsAsAPercentage() {
        XCTAssertEqual(BuyerTrustScoreView.multiplierText(1.25), "25% more on every reward")
        XCTAssertEqual(BuyerTrustScoreView.multiplierText(1.1), "10% more on every reward")
    }

    func test_hasAnyPerkIsTrueForEachPerkOnItsOwn() {
        let none = BuyerReputation.new.perks
        XCTAssertFalse(BuyerTrustScoreView.hasAnyPerk(none))
        XCTAssertTrue(BuyerTrustScoreView.hasAnyPerk(BuyerReputation.Perks(
            guaranteeWindowBonusDays: 7, priorityClaimHandling: false,
            earlyDropAccess: false, rewardMultiplier: 1.0)))
        XCTAssertTrue(BuyerTrustScoreView.hasAnyPerk(BuyerReputation.Perks(
            guaranteeWindowBonusDays: 0, priorityClaimHandling: true,
            earlyDropAccess: false, rewardMultiplier: 1.0)))
        XCTAssertTrue(BuyerTrustScoreView.hasAnyPerk(BuyerReputation.Perks(
            guaranteeWindowBonusDays: 0, priorityClaimHandling: false,
            earlyDropAccess: true, rewardMultiplier: 1.0)))
        XCTAssertTrue(BuyerTrustScoreView.hasAnyPerk(BuyerReputation.Perks(
            guaranteeWindowBonusDays: 0, priorityClaimHandling: false,
            earlyDropAccess: false, rewardMultiplier: 1.1)))
    }

    // The registry, the Swift table and the screen have to agree that this one
    // is shipped. The parity test holds the first two together; this holds the
    // third, so a capability cannot claim a screen the app does not route to.
    func test_theTrustScoreCapabilityClaimsToBeShippedHere() {
        guard let capability = BuyerCapability.all.first(where: { $0.id == "trustScore" }) else {
            return XCTFail("trustScore is missing from the capability table")
        }
        XCTAssertEqual(capability.delivery, .shipped)
        XCTAssertEqual(
            BuyerToolsSection.status(for: capability),
            "Available in this app.")
    }
}

/// A reference box so a closure can record that it ran without mutating a
/// captured local, which Swift concurrency rejects.
@MainActor
private final class CallCounter {
    var count = 0
}
