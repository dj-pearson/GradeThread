import XCTest
@testable import GradeThread

/// US-2503 AC2 screen 2: the closet portfolio.
@MainActor
final class BuyerPortfolioStoreTests: XCTestCase {

    private func entitlements(portfolio unlocked: Bool) -> BuyerEntitlementsStore {
        BuyerEntitlementsStore(fetch: {
            BuyerEntitlements(
                plan: unlocked ? "connoisseur" : "free",
                gateFlags: ["wardrobePortfolio": unlocked],
                allowances: .free)
        })
    }

    private func item(
        id: String = "c1",
        brand: String? = "Barbour",
        garmentType: String? = "waxed jacket",
        estimateCents: Int? = 18_000,
        confidence: String = "high",
        sellGuidance: String = "hold"
    ) -> BuyerPortfolioItem {
        BuyerPortfolioItem(
            id: id,
            brand: brand,
            garmentType: garmentType,
            size: "M",
            title: nil,
            conditionGrade: 8.5,
            certificateId: "GT-9",
            estimateCents: estimateCents,
            costBasisCents: 12_000,
            confidence: confidence,
            trend: "up",
            sellGuidance: sellGuidance)
    }

    private func totals(
        valued: Int = 1,
        unvalued: Int = 0,
        estimate: Int = 18_000,
        basis: Int = 12_000
    ) -> BuyerPortfolioTotals {
        BuyerPortfolioTotals(
            totalEstimateCents: estimate,
            costBasisCents: basis,
            unrealizedGainCents: estimate - basis,
            itemsValued: valued,
            itemsUnvalued: unvalued)
    }

    func test_anUnlockedPlanLoadsTheValuedCloset() async {
        let ent = entitlements(portfolio: true)
        await ent.load()
        let portfolio = BuyerPortfolio(items: [item()], totals: totals())
        let store = BuyerPortfolioStore(fetch: { portfolio })

        await store.load(entitlements: ent)

        XCTAssertEqual(store.phase, .ready(portfolio))
    }

    func test_aLockedPlanIsLockedAndSpendsNoRequest() async {
        let ent = entitlements(portfolio: false)
        await ent.load()
        let calls = PortfolioCallCounter()
        let store = BuyerPortfolioStore(fetch: {
            calls.count += 1
            return BuyerPortfolio(items: [], totals: self.totals())
        })

        await store.load(entitlements: ent)

        XCTAssertEqual(store.phase, .locked)
        XCTAssertEqual(calls.count, 0)
    }

    func test_aFailedLoadIsFailedRatherThanAnEmptyCloset() async {
        // An empty closet and a closet we could not read look identical on
        // screen, and one of them means the user lost everything.
        let ent = entitlements(portfolio: true)
        await ent.load()
        let store = BuyerPortfolioStore(fetch: { throw URLError(.timedOut) })

        await store.load(entitlements: ent)

        guard case .failed = store.phase else {
            return XCTFail("expected .failed, got \(store.phase)")
        }
    }

    // An item we have not priced is NOT an item worth nothing, and the two are
    // indistinguishable once they are both "$0.00".
    func test_anUnvaluedItemSaysSoRatherThanShowingZero() {
        let unvalued = item(estimateCents: nil)
        XCTAssertEqual(BuyerPortfolioView.itemDetail(unvalued), "Not valued yet")
        XCTAssertNotEqual(BuyerPortfolioView.itemDetail(unvalued), "$0.00")
    }

    // A total that silently omits part of the closet is worse than one that
    // says what it left out.
    func test_theFooterNamesWhatTheTotalDoesNotInclude() {
        XCTAssertEqual(
            BuyerPortfolioView.coverageFooter(totals(valued: 4, unvalued: 0)),
            "Based on all 4 items in your closet.")
        XCTAssertEqual(
            BuyerPortfolioView.coverageFooter(totals(valued: 4, unvalued: 1)),
            "Based on 4 items. 1 item not valued yet, and not counted above.")
        XCTAssertEqual(
            BuyerPortfolioView.coverageFooter(totals(valued: 4, unvalued: 3)),
            "Based on 4 items. 3 items not valued yet, and not counted above.")
        XCTAssertEqual(
            BuyerPortfolioView.coverageFooter(totals(valued: 0, unvalued: 6)),
            "None of your items have been valued yet.")
    }

    // A gain and a loss are different facts. Rendering both as "$12.00" tells a
    // buyer their wardrobe went up when it went down.
    func test_gainsAndLossesAreDistinguishable() {
        XCTAssertEqual(BuyerPortfolioView.signedMoney(6_000), "+$60.00")
        XCTAssertEqual(BuyerPortfolioView.signedMoney(-6_000), "-$60.00")
        XCTAssertEqual(BuyerPortfolioView.signedMoney(0), "$0.00")
    }

    // A weak estimate must not carry the same weight as a strong one.
    func test_aLowConfidenceEstimateSaysItIsRough() {
        XCTAssertEqual(
            BuyerPortfolioView.itemDetail(item(confidence: "low")),
            "$180.00 - rough estimate")
        XCTAssertEqual(
            BuyerPortfolioView.itemDetail(item(confidence: "high")),
            "$180.00")
        XCTAssertEqual(
            BuyerPortfolioView.itemDetail(item(confidence: "high", sellGuidance: "sell_now")),
            "$180.00 - good time to sell")
    }

    func test_displayNameFallsBackRatherThanShowingBlank() {
        XCTAssertEqual(item().displayName, "Barbour waxed jacket")
        XCTAssertEqual(item(garmentType: nil).displayName, "Barbour")
        XCTAssertEqual(item(brand: nil).displayName, "waxed jacket")
        XCTAssertEqual(item(brand: nil, garmentType: nil).displayName, "Untitled item")
        XCTAssertEqual(item(brand: "  ", garmentType: "  ").displayName, "Untitled item")
    }

    func test_thePortfolioCapabilityClaimsToBeShippedHere() {
        guard let capability = BuyerCapability.all.first(where: { $0.id == "wardrobePortfolio" }) else {
            return XCTFail("wardrobePortfolio is missing from the capability table")
        }
        XCTAssertEqual(capability.delivery, .shipped)
        XCTAssertEqual(BuyerToolsSection.status(for: capability), "Available in this app.")
    }
}

@MainActor
private final class PortfolioCallCounter {
    var count = 0
}
