import XCTest
@testable import GradeThread

/// US-2503 AC4: a Business-tier payload unlocks the Connoisseur-gated
/// capabilities and a free payload locks them.
@MainActor
final class BuyerEntitlementsStoreTests: XCTestCase {

    // SELLER_PLAN_BUYER_TIER maps Business to the Connoisseur buyer tier, which
    // is every flag on. Built from the capability table rather than a hand-typed
    // key list, so a capability added to the registry is covered here the moment
    // it is mirrored into Swift.
    private func connoisseurPayload() -> BuyerEntitlements {
        var flags: [String: Bool] = [:]
        for capability in BuyerCapability.all { flags[capability.id] = true }
        return BuyerEntitlements(
            plan: "connoisseur",
            gateFlags: flags,
            allowances: BuyerAllowances(
                extensionChecksPerMonth: -1,
                authenticityCreditsPerMonth: 3,
                videoGradeCreditsPerMonth: 2,
                activeAlertsCap: 100,
                portfolioItemCap: -1,
                alertFrequency: "instant"))
    }

    private func makeStore(_ result: Result<BuyerEntitlements, Error>) -> BuyerEntitlementsStore {
        BuyerEntitlementsStore(fetch: { try result.get() })
    }

    private func capability(_ id: String) -> BuyerCapability {
        guard let found = BuyerCapability.all.first(where: { $0.id == id }) else {
            XCTFail("no capability \(id) in the table")
            return BuyerCapability(id: id, label: id, delivery: .planned, note: nil)
        }
        return found
    }

    func test_businessTierPayloadUnlocksTheConnoisseurGatedCapabilities() async {
        let store = makeStore(.success(connoisseurPayload()))

        await store.load()

        XCTAssertEqual(store.entitlements.plan, "connoisseur")
        XCTAssertFalse(store.loadFailed)
        XCTAssertTrue(store.isIncluded(capability("trustScore")))
        XCTAssertTrue(store.isIncluded(capability("purchaseGuarantee")))
        XCTAssertTrue(store.isIncluded(capability("wardrobePortfolio")))
        XCTAssertTrue(store.isIncluded(capability("conditionAlerts")))
    }

    func test_freePayloadLocksThem() async {
        let free = BuyerEntitlements(
            plan: "free",
            gateFlags: ["extensionSecondOpinion": true],
            allowances: .free)
        let store = makeStore(.success(free))

        await store.load()

        XCTAssertFalse(store.isIncluded(capability("trustScore")))
        XCTAssertFalse(store.isIncluded(capability("purchaseGuarantee")))
        XCTAssertFalse(store.isIncluded(capability("wardrobePortfolio")))
        // ...and the one the free tier DOES carry is still on, so the test is
        // reading the payload rather than reading "free" and short-circuiting.
        XCTAssertTrue(store.isIncluded(capability("extensionSecondOpinion")))
    }

    // The failure direction is the whole design. A request that does not
    // complete must resolve LOCKED: a screen that unlocks on a hiccup is
    // indistinguishable from a real entitlement, and it lasts until relaunch.
    func test_aFailedLoadResolvesLockedAndSaysSo() async {
        let store = makeStore(.failure(URLError(.timedOut)))

        await store.load()

        XCTAssertEqual(store.entitlements, .free)
        XCTAssertTrue(store.loadFailed, "a failed read must be distinguishable from the free plan")
        XCTAssertFalse(store.isIncluded(capability("trustScore")))
    }

    // A later failure must not leave an earlier unlock standing. This is the
    // case that separates "fail safe" from "fail safe the first time".
    func test_aFailureAfterASuccessDropsBackToLocked() async {
        let box = ResultBox(.success(connoisseurPayload()))
        let store = BuyerEntitlementsStore(fetch: { try box.value.get() })
        await store.load()
        XCTAssertTrue(store.isIncluded(capability("trustScore")))

        box.value = .failure(URLError(.notConnectedToInternet))
        await store.load()

        XCTAssertFalse(store.isIncluded(capability("trustScore")), "a stale unlock must not survive")
        XCTAssertTrue(store.loadFailed)
    }

    // isUsable is a different question from isIncluded, and conflating them is
    // how a paying subscriber gets told to upgrade for something they already
    // pay for. Every AC2 capability is `planned` until its screen lands, so it
    // is included and not yet usable.
    func test_includedButNotYetOnIPhoneIsNotUsable() async {
        let store = makeStore(.success(connoisseurPayload()))
        await store.load()

        let alerts = capability("conditionAlerts")
        XCTAssertEqual(alerts.delivery, .planned)
        XCTAssertTrue(store.isIncluded(alerts))
        XCTAssertFalse(store.isUsable(alerts), "no screen exists yet, so it is not usable here")

        let support = capability("prioritySupport")
        XCTAssertEqual(support.delivery, .shipped)
        XCTAssertTrue(store.isUsable(support))
    }

    // The desktop-only entries must each carry the sentence the plan screen
    // shows. A bundled capability that renders as a blank line reads as a bug.
    func test_everyDesktopOnlyCapabilityExplainsWhereItLives() {
        for capability in BuyerCapability.all where capability.delivery == .desktopOnly {
            XCTAssertFalse(
                BuyerToolsSection.status(for: capability).isEmpty,
                "\(capability.id) has no location sentence")
        }
    }
}

/// A mutable box so a test can change what the fetch closure returns between
/// loads. `@MainActor` on the test class keeps this single-threaded.
@MainActor
private final class ResultBox {
    var value: Result<BuyerEntitlements, Error>
    init(_ value: Result<BuyerEntitlements, Error>) { self.value = value }
}
