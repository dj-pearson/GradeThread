import XCTest
@testable import GradeThread

/// US-2503 AC2 screen 1: condition alerts. The last of the four.
@MainActor
final class BuyerAlertsStoreTests: XCTestCase {

    private func entitlements(alerts unlocked: Bool, cap: Int = 5) -> BuyerEntitlementsStore {
        BuyerEntitlementsStore(fetch: {
            BuyerEntitlements(
                plan: unlocked ? "guard" : "free",
                gateFlags: ["conditionAlerts": unlocked],
                allowances: BuyerAllowances(
                    extensionChecksPerMonth: 0,
                    authenticityCreditsPerMonth: 0,
                    videoGradeCreditsPerMonth: 0,
                    activeAlertsCap: cap,
                    portfolioItemCap: 0,
                    alertFrequency: "daily"))
        })
    }

    private func search(
        id: String = "s1",
        label: String = "Barbour jackets",
        brands: [String] = ["Barbour"],
        keywords: [String] = [],
        minGrade: Double? = 8,
        maxPriceCents: Int? = 20_000,
        isActive: Bool = true
    ) -> BuyerSavedSearch {
        BuyerSavedSearch(
            id: id,
            label: label,
            brands: brands,
            keywords: keywords,
            minGrade: minGrade,
            maxPriceCents: maxPriceCents,
            isActive: isActive,
            lastMatchedAt: nil)
    }

    private func ready(_ searches: [BuyerSavedSearch], cap: Int = 5) async -> BuyerAlertsStore {
        let ent = entitlements(alerts: true, cap: cap)
        await ent.load()
        let store = BuyerAlertsStore(service: FakeAlertsService(searches: searches))
        await store.load(entitlements: ent)
        return store
    }

    func test_anUnlockedPlanLoadsAlertsAndMatches() async {
        let store = await ready([search()])

        XCTAssertEqual(store.phase, .ready(.init(searches: [search()], matches: [])))
        XCTAssertEqual(store.activeCount, 1)
    }

    func test_aLockedPlanIsLockedAndSpendsNoRequest() async {
        let ent = entitlements(alerts: false)
        await ent.load()
        let fake = FakeAlertsService(searches: [search()])
        let store = BuyerAlertsStore(service: fake)

        await store.load(entitlements: ent)

        XCTAssertEqual(store.phase, .locked)
        XCTAssertEqual(fake.searchCalls, 0)
    }

    // An empty alerts screen tells a buyer their saved setup is gone. It is not
    // gone; the read failed.
    func test_aFailedLoadIsFailedRatherThanAnEmptyAlertList() async {
        let ent = entitlements(alerts: true)
        await ent.load()
        let fake = FakeAlertsService(searches: [])
        fake.readError = URLError(.timedOut)
        let store = BuyerAlertsStore(service: fake)

        await store.load(entitlements: ent)

        guard case .failed = store.phase else {
            return XCTFail("expected .failed, got \(store.phase)")
        }
    }

    // THE ONE THAT MATTERS MOST HERE. A toggle that stays flipped after a
    // refused write says an alert is running when it is not, and the buyer finds
    // out by never being alerted — which is silence, and silence is what a
    // working alert also looks like until it fires.
    func test_aRefusedToggleGoesBackRatherThanLookingSaved() async {
        let store = await ready([search(isActive: true)])
        guard case .ready(let before) = store.phase, let target = before.searches.first else {
            return XCTFail("not ready")
        }

        await store.setActive(target, active: false)

        guard case .ready(let after) = store.phase else { return XCTFail("not ready") }
        XCTAssertEqual(after.searches.first?.isActive, false, "the happy path still saves")

        // Now refuse the write.
        let refusing = FakeAlertsService(searches: [search(isActive: true)])
        refusing.writeError = URLError(.badServerResponse)
        let ent = entitlements(alerts: true)
        await ent.load()
        let store2 = BuyerAlertsStore(service: refusing)
        await store2.load(entitlements: ent)
        guard case .ready(let loaded2) = store2.phase, let target2 = loaded2.searches.first else {
            return XCTFail("not ready")
        }

        await store2.setActive(target2, active: false)

        guard case .ready(let reverted) = store2.phase else { return XCTFail("not ready") }
        XCTAssertEqual(reverted.searches.first?.isActive, true, "a refused write must not stick")
        XCTAssertNotNil(store2.actionError)
    }

    func test_theCapBlocksActivatingAnotherAndNeverWrites() async {
        let store = await ready([search(id: "a"), search(id: "b", isActive: false)], cap: 1)
        guard case .ready(let loaded) = store.phase,
              let paused = loaded.searches.first(where: { $0.id == "b" }) else {
            return XCTFail("not ready")
        }
        XCTAssertFalse(store.canActivateAnother)

        await store.setActive(paused, active: true)

        guard case .ready(let after) = store.phase else { return XCTFail("not ready") }
        XCTAssertEqual(after.searches.first(where: { $0.id == "b" })?.isActive, false)
        XCTAssertNotNil(store.actionError)
    }

    func test_anUnlimitedCapNeverBlocks() async {
        let store = await ready([search(id: "a"), search(id: "b")], cap: -1)
        XCTAssertTrue(store.canActivateAnother)
        XCTAssertEqual(BuyerAlertsView.capFooter(active: 2, cap: -1), "2 active - unlimited on your plan.")
        XCTAssertEqual(BuyerAlertsView.capFooter(active: 2, cap: 5), "2 of 5 active alerts used.")
    }

    // A row that shows only its label is a list of names, not of searches.
    func test_theRowSaysWhatTheAlertIsLookingFor() {
        XCTAssertEqual(
            search().criteriaSummary,
            "Barbour - grade 8+ - under $200.00")
        XCTAssertEqual(
            search(brands: [], keywords: ["waxed"], minGrade: nil, maxPriceCents: nil).criteriaSummary,
            "waxed")
        XCTAssertEqual(
            search(brands: [], keywords: [], minGrade: nil, maxPriceCents: nil).criteriaSummary,
            "Anything newly graded")
    }

    // A trailing comma is how a person finishes typing a list, and an empty
    // brand would match everything.
    func test_theListParserDropsBlanksAndDuplicates() {
        XCTAssertEqual(BuyerAlertEditor.splitList("Barbour, Filson,"), ["Barbour", "Filson"])
        XCTAssertEqual(BuyerAlertEditor.splitList("  ,  , "), [])
        XCTAssertEqual(BuyerAlertEditor.splitList("Levi's, levi's"), ["Levi's"])
        XCTAssertEqual(BuyerAlertEditor.splitList(""), [])
    }

    // A typed "80" would store a floor no garment can reach, and the alert would
    // sit there active and silent forever.
    func test_theGradeIsClampedToTheRealScale() {
        XCTAssertEqual(BuyerAlertEditor.parseGrade("8.5"), 8.5)
        XCTAssertEqual(BuyerAlertEditor.parseGrade("80"), 10)
        XCTAssertEqual(BuyerAlertEditor.parseGrade("0"), 1)
        XCTAssertNil(BuyerAlertEditor.parseGrade(""))
        XCTAssertNil(BuyerAlertEditor.parseGrade("about eight"))
    }

    func test_thePriceParserTakesDollarsAndRejectsNonsense() {
        XCTAssertEqual(BuyerAlertEditor.parseCents("200"), 20_000)
        XCTAssertEqual(BuyerAlertEditor.parseCents("$1,250.50"), 125_050)
        XCTAssertNil(BuyerAlertEditor.parseCents(""))
        XCTAssertNil(BuyerAlertEditor.parseCents("-5"), "a negative cap is a cap nothing can be under")
        XCTAssertNil(BuyerAlertEditor.parseCents("free"))
    }

    // A mismatch here shows an EMPTY FEED rather than an error, which is the
    // worst way for a string constant to be wrong.
    func test_theMatchTypeStillMatchesTheWebConstant() {
        XCTAssertEqual(BuyerAlertsService.conditionAlertType, "buyer_condition_alert")
    }

    func test_theAlertsCapabilityClaimsToBeShippedHere() {
        guard let capability = BuyerCapability.all.first(where: { $0.id == "conditionAlerts" }) else {
            return XCTFail("conditionAlerts is missing from the capability table")
        }
        XCTAssertEqual(capability.delivery, .shipped)
        XCTAssertEqual(BuyerToolsSection.status(for: capability), "Available in this app.")
    }
}

@MainActor
private final class FakeAlertsService: BuyerAlertsServing {
    var stored: [BuyerSavedSearch]
    var readError: Error?
    var writeError: Error?
    private(set) var searchCalls = 0

    init(searches: [BuyerSavedSearch]) { self.stored = searches }

    func searches() async throws -> [BuyerSavedSearch] {
        searchCalls += 1
        if let readError { throw readError }
        return stored
    }

    func matches() async throws -> [BuyerAlertMatch] {
        if let readError { throw readError }
        return []
    }

    func setActive(id: String, active: Bool) async throws {
        if let writeError { throw writeError }
        if let i = stored.firstIndex(where: { $0.id == id }) { stored[i].isActive = active }
    }

    func delete(id: String) async throws {
        if let writeError { throw writeError }
        stored.removeAll { $0.id == id }
    }

    func create(
        label: String,
        brands: [String],
        keywords: [String],
        minGrade: Double?,
        maxPriceCents: Int?
    ) async throws -> BuyerSavedSearch {
        if let writeError { throw writeError }
        let created = BuyerSavedSearch(
            id: "new-\(stored.count)",
            label: label,
            brands: brands,
            keywords: keywords,
            minGrade: minGrade,
            maxPriceCents: maxPriceCents,
            isActive: true,
            lastMatchedAt: nil)
        stored.insert(created, at: 0)
        return created
    }
}
