import XCTest
@testable import GradeThread

/// US-1224 — coverage for the US-1170 / US-1225 Prospect logic that lives on the
/// CLIENT (the buy/skip ROI verdict itself is computed server-side and only
/// decoded, so it isn't re-asserted here). The two testable, deterministic
/// pieces are:
///   • `costNeedsRerun` — detects when the cost typed/changed after a run no
///     longer matches the cost the (server-computed) verdict was run with, so
///     the view can prompt a re-run.
///   • the AI-read "prospect notes" folded into the inventory item on commit
///     (keywords + resolved category), verified through the buy request the
///     store hands to the service.
///
/// `ProspectStore` is `@MainActor`; the fake `Prospecting` service keeps this
/// fully headless (no network, no Vision, no Speech).
@MainActor
final class ProspectStoreTests: XCTestCase {

    // MARK: - Fake service

    private final class FakeProspecting: Prospecting {
        var prospectResult: ProspectResponse?
        var buyResult: ProspectBuyResponse = .init(id: "item-1", status: "sourced")
        /// Captures the request `addToInventory()` builds so we can assert the
        /// notes / target / grade it folded in.
        private(set) var capturedBuy: ProspectBuyRequest?

        func prospect(images: [Data], costCents: Int?) async throws -> ProspectResponse {
            guard let prospectResult else { throw EdgeAPIError.network("no fixture") }
            return prospectResult
        }

        func buy(_ request: ProspectBuyRequest) async throws -> ProspectBuyResponse {
            capturedBuy = request
            return buyResult
        }
    }

    // MARK: - Fixtures

    private func item(brand: String? = "Patagonia",
                      title: String? = "Patagonia Synchilla Fleece",
                      keywords: [String] = ["fleece", "synchilla"]) -> ProspectItem {
        ProspectItem(brand: brand, title: title, keywords: keywords, identifyConfidence: 0.9)
    }

    private func response(identified: Bool = true,
                          item: ProspectItem? = nil,
                          category: ProspectCategory? = ProspectCategory(id: "57988", path: "Men > Coats & Jackets"),
                          medianCents: Int? = 4200,
                          gradeValue: Double? = 8.0,
                          costCents: Int?) -> ProspectResponse {
        let stats = medianCents.map {
            ProspectStats(count: 12, lowCents: 3000, medianCents: $0, highCents: 6000,
                          currency: "USD", confidence: 0.8, sufficient: true)
        }
        let grade = gradeValue.map { ProspectGrade(value: $0, tier: "excellent", confidence: 0.8) }
        return ProspectResponse(
            identified: identified,
            item: item ?? self.item(),
            category: category,
            grade: grade,
            stats: stats,
            sellThrough: nil,
            costCents: costCents,
            decision: nil,
            ebaySoldSearchUrl: nil,
            source: "active",
            disclaimer: nil,
            note: nil
        )
    }

    // MARK: - costNeedsRerun

    func test_costNeedsRerun_falseWhenNoResultYet() {
        let store = ProspectStore(service: FakeProspecting())
        store.costText = "20"
        XCTAssertFalse(store.costNeedsRerun, "No result → nothing to re-run.")
    }

    func test_costNeedsRerun_falseWhenCostMatchesRun() {
        let store = ProspectStore(service: FakeProspecting())
        // Verdict was run at $20.00 (2000 cents) and the field still says 20.
        store.result = response(costCents: 2000)
        store.costText = "20"
        XCTAssertFalse(store.costNeedsRerun)
    }

    func test_costNeedsRerun_trueWhenCostChangedAfterRun() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: 2000)   // ran at $20
        store.costText = "35"                       // user bumped it to $35
        XCTAssertTrue(store.costNeedsRerun)
    }

    func test_costNeedsRerun_trueWhenCostAddedAfterCostlessRun() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: nil)     // ran with no cost → no verdict
        store.costText = "15"                        // now a cost is entered
        XCTAssertTrue(store.costNeedsRerun)
    }

    func test_costNeedsRerun_handlesCurrencyFormatting() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: 1234)    // $12.34
        store.costText = "$12.34"                    // formatted, with symbol
        XCTAssertFalse(store.costNeedsRerun, "$ and matching value → no re-run needed.")
    }

    // MARK: - addToInventory notes / prefill (US-1170)

    func test_addToInventory_foldsKeywordsAndCategoryIntoNotes() async {
        let fake = FakeProspecting()
        let store = ProspectStore(service: fake)
        store.result = response(
            item: item(keywords: ["fleece", "synchilla", "vintage"]),
            category: ProspectCategory(id: "57988", path: "Men > Coats & Jackets"),
            costCents: 2000
        )
        store.costText = "20"

        await store.addToInventory()

        let req = try? XCTUnwrap(fake.capturedBuy)
        XCTAssertEqual(req?.title, "Patagonia Synchilla Fleece")
        XCTAssertEqual(req?.brand, "Patagonia")
        XCTAssertEqual(req?.costCents, 2000)
        XCTAssertEqual(req?.targetCents, 4200, "target prefilled from median comp")
        XCTAssertEqual(req?.gradeValue, 8.0)
        XCTAssertEqual(req?.gradeLabel, "excellent")
        XCTAssertEqual(req?.conditionNotes, "fleece, synchilla, vintage · Category: Men > Coats & Jackets")
        XCTAssertEqual(store.addedItemId, "item-1")
        XCTAssertNil(store.addError)
    }

    func test_addToInventory_nilNotesWhenNothingToRecord() async {
        let fake = FakeProspecting()
        let store = ProspectStore(service: fake)
        store.result = response(
            item: item(keywords: []),
            category: nil,
            costCents: nil
        )

        await store.addToInventory()

        let req = try? XCTUnwrap(fake.capturedBuy)
        XCTAssertNil(req?.conditionNotes, "No keywords + no category → no notes string.")
    }

    func test_addToInventory_rejectsUnidentifiedResult() async {
        let fake = FakeProspecting()
        let store = ProspectStore(service: fake)
        store.result = response(identified: false, costCents: nil)

        await store.addToInventory()

        XCTAssertNil(fake.capturedBuy, "Nothing to buy when the item wasn't identified.")
        XCTAssertNotNil(store.addError)
        XCTAssertNil(store.addedItemId)
    }
}
