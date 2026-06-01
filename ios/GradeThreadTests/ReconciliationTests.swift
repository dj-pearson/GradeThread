import XCTest
@testable import GradeThread

@MainActor
final class ReconciliationTests: XCTestCase {

    // MARK: - OrphanEbayListing decoding

    func test_orphan_decodesAllSnakeCaseFields() throws {
        let json = #"""
        {
          "id": "row-1",
          "ebay_item_id": "1234567890",
          "custom_label": "S-12",
          "title": "Vintage Pendleton wool shirt",
          "current_price": 38.0,
          "available_quantity": 1,
          "listing_url": "https://www.ebay.com/itm/1234567890",
          "listing_format": "FIXED_PRICE",
          "imported_at": "2026-05-01T12:00:00Z"
        }
        """#
        let parsed = try JSONDecoder().decode(OrphanEbayListing.self, from: Data(json.utf8))
        XCTAssertEqual(parsed.id, "row-1")
        XCTAssertEqual(parsed.ebayItemId, "1234567890")
        XCTAssertEqual(parsed.customLabel, "S-12")
        XCTAssertEqual(parsed.title, "Vintage Pendleton wool shirt")
        XCTAssertEqual(try XCTUnwrap(parsed.currentPrice), 38.0, accuracy: 0.0001)
        XCTAssertEqual(parsed.availableQuantity, 1)
        XCTAssertEqual(parsed.listingURL, "https://www.ebay.com/itm/1234567890")
        XCTAssertEqual(parsed.listingFormat, "FIXED_PRICE")
    }

    func test_orphan_decodesNullableFields() throws {
        let json = #"""
        {
          "id": "row-2",
          "ebay_item_id": "abc",
          "custom_label": null,
          "title": null,
          "current_price": null,
          "available_quantity": null,
          "listing_url": null,
          "listing_format": null,
          "imported_at": "2026-05-01T12:00:00Z"
        }
        """#
        let parsed = try JSONDecoder().decode(OrphanEbayListing.self, from: Data(json.utf8))
        XCTAssertNil(parsed.customLabel)
        XCTAssertNil(parsed.title)
        XCTAssertNil(parsed.currentPrice)
        XCTAssertNil(parsed.listingURL)
    }

    func test_orphan_displayTitle_fallsBackToEbayId() {
        let orphan = OrphanEbayListing(
            id: "r", ebayItemId: "1234567890",
            customLabel: nil, title: nil, currentPrice: nil,
            availableQuantity: nil, listingURL: nil, listingFormat: nil,
            importedAt: "2026-05-01T12:00:00Z"
        )
        XCTAssertEqual(orphan.displayTitle, "Listing 1234567890")
    }

    func test_orphan_displayTitle_emptyStringFallsBack() {
        let orphan = OrphanEbayListing(
            id: "r", ebayItemId: "111",
            customLabel: nil, title: "", currentPrice: nil,
            availableQuantity: nil, listingURL: nil, listingFormat: nil,
            importedAt: "2026-05-01T12:00:00Z"
        )
        XCTAssertEqual(orphan.displayTitle, "Listing 111")
    }

    // MARK: - ReconciliationOutcome

    func test_outcome_isSuccess_excludesFailed() {
        XCTAssertTrue(ReconciliationOutcome(orphanId: "r", kind: .created(itemId: "i")).isSuccess)
        XCTAssertTrue(ReconciliationOutcome(orphanId: "r", kind: .linked(itemId: "i")).isSuccess)
        XCTAssertTrue(ReconciliationOutcome(orphanId: "r", kind: .ignored).isSuccess)
        XCTAssertFalse(ReconciliationOutcome(orphanId: "r", kind: .failed(message: "x")).isSuccess)
    }

    // MARK: - ReconciliationBulkResult.summary

    func test_bulkResult_summary_allSucceeded() {
        let result = ReconciliationBulkResult(succeeded: 3, failures: [])
        XCTAssertEqual(result.summary, "Created 3 items from eBay.")
    }

    func test_bulkResult_summary_singularGrammar() {
        let result = ReconciliationBulkResult(succeeded: 1, failures: [])
        XCTAssertEqual(result.summary, "Created 1 item from eBay.")
    }

    func test_bulkResult_summary_allFailed() {
        let result = ReconciliationBulkResult(
            succeeded: 0,
            failures: [("a", "x"), ("b", "y")]
        )
        XCTAssertEqual(result.summary, "All 2 items failed.")
    }

    func test_bulkResult_summary_partial() {
        let result = ReconciliationBulkResult(
            succeeded: 2,
            failures: [("c", "boom")]
        )
        XCTAssertEqual(result.summary, "Created 2 of 3 items; 1 failed.")
    }

    // MARK: - ReconciliationStore

    func test_store_initialPhase_isLoading() {
        let store = ReconciliationStore()
        if case .loading = store.phase { } else {
            XCTFail("expected initial phase = .loading, got \(store.phase)")
        }
        XCTAssertEqual(store.count, 0)
        XCTAssertNil(store.lastBulkResult)
    }

    func test_store_runAction_removesOnSuccess() async {
        let store = ReconciliationStore()
        let orphan = makeOrphan(id: "o1")
        store.phase = .ready(orphans: [orphan, makeOrphan(id: "o2")])

        await store.runAction(on: orphan) { o in
            ReconciliationOutcome(orphanId: o.id, kind: .ignored)
        }
        XCTAssertEqual(store.count, 1)
        XCTAssertEqual(store.orphans.first?.id, "o2")
    }

    func test_store_runAction_restoresOnFailure() async {
        let store = ReconciliationStore()
        let orphans = [makeOrphan(id: "o1"), makeOrphan(id: "o2")]
        store.phase = .ready(orphans: orphans)

        await store.runAction(on: orphans[0]) { o in
            ReconciliationOutcome(orphanId: o.id, kind: .failed(message: "nope"))
        }
        // Optimistic removal followed by restore — the list stays visible
        // (phase remains .ready so one failed action doesn't replace the whole
        // screen with a load-failure banner) and the error surfaces via
        // lastActionError for a toast.
        XCTAssertEqual(store.count, 2)
        XCTAssertEqual(store.lastActionError, "nope")
        if case .failed = store.phase {
            XCTFail("a failed action must not flip the screen to the load-failure phase")
        }
    }

    // MARK: - Helpers

    private func makeOrphan(id: String) -> OrphanEbayListing {
        OrphanEbayListing(
            id: id,
            ebayItemId: "ebay-\(id)",
            customLabel: nil,
            title: "Test \(id)",
            currentPrice: 10.0,
            availableQuantity: 1,
            listingURL: nil,
            listingFormat: "FIXED_PRICE",
            importedAt: "2026-05-01T12:00:00Z"
        )
    }
}
