import XCTest
@testable import GradeThread

/// US-2503 AC2 screen 4: purchase-guarantee coverage.
@MainActor
final class BuyerGuaranteeStoreTests: XCTestCase {

    private func entitlements(guarantee unlocked: Bool) -> BuyerEntitlementsStore {
        BuyerEntitlementsStore(fetch: {
            BuyerEntitlements(
                plan: unlocked ? "guard" : "free",
                gateFlags: ["purchaseGuarantee": unlocked],
                allowances: .free)
        })
    }

    private func purchase(
        id: String = "p1",
        coverage: BuyerCoveredPurchase.Coverage? = nil,
        claim: BuyerCoveredPurchase.Claim? = nil
    ) -> BuyerCoveredPurchase {
        BuyerCoveredPurchase(
            id: id,
            brand: "Patagonia",
            title: "Retro-X fleece",
            certificateId: "GT-1",
            purchasePriceCents: 12_000,
            purchasedAt: nil,
            coverage: coverage,
            claim: claim)
    }

    private func covered() -> BuyerCoveredPurchase.Coverage {
        BuyerCoveredPurchase.Coverage(
            eligible: true,
            ineligibleReason: nil,
            windowDays: 30,
            payoutCapCents: 15_000,
            gradeDeltaThreshold: 0.5,
            coveredUntil: "2026-09-30T00:00:00Z")
    }

    func test_anUnlockedPlanLoadsTheCoverageList() async {
        let ent = entitlements(guarantee: true)
        await ent.load()
        let store = BuyerGuaranteeStore(fetch: { [self.purchase(coverage: self.covered())] })

        await store.load(entitlements: ent)

        XCTAssertEqual(store.phase, .ready([purchase(coverage: covered())]))
    }

    func test_aLockedPlanIsLockedAndSpendsNoRequest() async {
        let ent = entitlements(guarantee: false)
        await ent.load()
        let calls = GuaranteeCallCounter()
        let store = BuyerGuaranteeStore(fetch: {
            calls.count += 1
            return []
        })

        await store.load(entitlements: ent)

        XCTAssertEqual(store.phase, .locked)
        XCTAssertEqual(calls.count, 0)
    }

    // A coverage screen that will not load must not read as coverage that has
    // lapsed. The phase carries the distinction; the view's copy says it out
    // loud ("It's unaffected - this is a display problem").
    func test_aFailedLoadIsFailedRatherThanAnEmptyCoverageList() async {
        let ent = entitlements(guarantee: true)
        await ent.load()
        let store = BuyerGuaranteeStore(fetch: { throw URLError(.timedOut) })

        await store.load(entitlements: ent)

        guard case .failed = store.phase else {
            return XCTFail("expected .failed, got \(store.phase)")
        }
    }

    // THE DISTINCTION THIS SCREEN EXISTS TO GET RIGHT. No coverage snapshot is
    // not the same fact as a snapshot that says no, and rendering them the same
    // way answers "am I covered?" with a confident no when the truth is "we have
    // not worked it out".
    func test_noSnapshotIsNotTheSameAsNotCovered() {
        let unknown = purchase(coverage: nil)
        let refused = purchase(coverage: BuyerCoveredPurchase.Coverage(
            eligible: false,
            ineligibleReason: "window_expired",
            windowDays: 30,
            payoutCapCents: 0,
            gradeDeltaThreshold: 0.5,
            coveredUntil: nil))

        XCTAssertNil(unknown.coverage)
        XCTAssertEqual(refused.coverage?.eligible, false)
        XCTAssertNotEqual(unknown, refused)
    }

    func test_ineligibleReasonsReadAsSentencesNotCodes() {
        XCTAssertEqual(
            BuyerGuaranteeView.ineligibleCopy("plan_not_covered"),
            "Your plan didn't include the guarantee when you bought this.")
        XCTAssertEqual(
            BuyerGuaranteeView.ineligibleCopy("window_expired"),
            "The coverage window for this purchase has closed.")
        XCTAssertEqual(
            BuyerGuaranteeView.ineligibleCopy("no_certificate"),
            "This purchase isn't linked to a verifiable certificate.")
        // An unknown reason must still be a sentence. A raw machine code in
        // front of a buyer is worse than a vaguer true one.
        XCTAssertEqual(
            BuyerGuaranteeView.ineligibleCopy("something_new_from_the_server"),
            "This purchase isn't covered.")
        XCTAssertEqual(
            BuyerGuaranteeView.ineligibleCopy(nil),
            "This purchase isn't covered.")
    }

    // 0.5 is our unit. "Half a grade point" is the thing a buyer can picture.
    func test_theThresholdReadsInGradePoints() {
        XCTAssertEqual(BuyerGuaranteeView.gradePoints(0.5), "half a grade point")
        XCTAssertEqual(BuyerGuaranteeView.gradePoints(1), "1 grade point")
        XCTAssertEqual(BuyerGuaranteeView.gradePoints(2), "2 grade points")
        XCTAssertEqual(BuyerGuaranteeView.gradePoints(1.5), "1.5 grade points")
    }

    func test_moneyAndDatesDegradeToADashRatherThanZero() {
        XCTAssertEqual(BuyerGuaranteeView.money(nil), "-")
        XCTAssertEqual(BuyerGuaranteeView.money(15_000), "$150.00")
        XCTAssertEqual(BuyerGuaranteeView.shortDate(nil), "-")
        XCTAssertEqual(BuyerGuaranteeView.shortDate("not a date"), "-")
    }

    // Postgres sends fractional seconds sometimes and not others, and a strict
    // formatter returns nil for whichever it was not configured for — a dash
    // where a date belongs. Both shapes must parse.
    func test_bothTimestampShapesParse() {
        XCTAssertNotEqual(BuyerGuaranteeView.shortDate("2026-09-30T00:00:00Z"), "-")
        XCTAssertNotEqual(BuyerGuaranteeView.shortDate("2026-09-30T00:00:00.123Z"), "-")
    }

    func test_theGuaranteeCapabilityClaimsToBeShippedHere() {
        guard let capability = BuyerCapability.all.first(where: { $0.id == "purchaseGuarantee" }) else {
            return XCTFail("purchaseGuarantee is missing from the capability table")
        }
        XCTAssertEqual(capability.delivery, .shipped)
        XCTAssertEqual(BuyerToolsSection.status(for: capability), "Available in this app.")
    }
}

@MainActor
private final class GuaranteeCallCounter {
    var count = 0
}
