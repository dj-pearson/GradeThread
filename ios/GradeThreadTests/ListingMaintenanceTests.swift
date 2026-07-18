import XCTest
@testable import GradeThread

/// US-1973: single-item quantity / out-of-stock + End listing on the item screen.
@MainActor
final class ListingMaintenanceTests: XCTestCase {

    /// Records what the store asked of the network and returns canned outcomes.
    /// `@MainActor` to match the protocol's isolation (and the store's), so the
    /// mutable call log is never touched off-actor.
    @MainActor
    private final class FakeService: ListingMaintenanceProviding {
        var quantityCalls: [(listingId: String, quantity: Int)] = []
        var endCalls: [String] = []
        var quantityOutcome: ReviseOutcome = .revised(
            ReviseResponse(ok: true, listingId: "L1", photosSynced: nil)
        )
        var endOutcome: PublishOutcome = .ended(
            EndListingResponse(ok: true, listingId: "L1", endedOnEbay: true, note: nil)
        )

        func updateQuantity(listingId: String, quantity: Int) async -> ReviseOutcome {
            quantityCalls.append((listingId, quantity))
            return quantityOutcome
        }

        func endListing(listingId: String) async -> PublishOutcome {
            endCalls.append(listingId)
            return endOutcome
        }
    }

    private func makeStore(
        quantity: Int?,
        service: FakeService
    ) -> ListingMaintenanceStore {
        ListingMaintenanceStore(listingId: "L1", quantity: quantity, service: service)
    }

    // MARK: - Seeding

    func test_seed_nilQuantityAssumesOneNotOutOfStock() {
        // A row synced before `listings.quantity` was mirrored reads nil. Seeding
        // 0 would badge a live, buyable listing as out of stock.
        let store = makeStore(quantity: nil, service: FakeService())
        XCTAssertEqual(store.quantity, 1)
        XCTAssertFalse(store.isOutOfStock)
        XCTAssertFalse(store.quantityChanged)
    }

    func test_seed_zeroQuantityReadsOutOfStock() {
        let store = makeStore(quantity: 0, service: FakeService())
        XCTAssertTrue(store.isOutOfStock)
    }

    func test_quantityChanged_onlyAfterTheStepperMoves() {
        let store = makeStore(quantity: 3, service: FakeService())
        XCTAssertFalse(store.quantityChanged, "an untouched stepper must not enable Update")
        store.quantity = 4
        XCTAssertTrue(store.quantityChanged)
    }

    // MARK: - Quantity (AC1)

    func test_applyQuantity_sendsTheTypedQuantityAndAdvancesTheBaseline() async {
        let service = FakeService()
        let store = makeStore(quantity: 1, service: service)
        store.quantity = 5

        let applied = await store.applyQuantity()

        XCTAssertEqual(applied, .quantity(5))
        XCTAssertEqual(service.quantityCalls.map(\.quantity), [5])
        XCTAssertEqual(service.quantityCalls.first?.listingId, "L1")
        // Baseline advanced by the CONFIRMED round-trip → Update settles.
        XCTAssertFalse(store.quantityChanged)
    }

    func test_markOutOfStock_sendsZero() async {
        let service = FakeService()
        let store = makeStore(quantity: 2, service: service)

        let applied = await store.markOutOfStock()

        XCTAssertEqual(applied, .quantity(0))
        XCTAssertEqual(service.quantityCalls.map(\.quantity), [0])
        XCTAssertTrue(store.isOutOfStock)
    }

    func test_applyQuantity_failureKeepsTheBaselineSoRetryStillDiffs() async {
        // US-1006 shape: a failed push must not advance the baseline, or the
        // Update button disables and the seller's change is silently stranded.
        let service = FakeService()
        service.quantityOutcome = .failed(message: "eBay rejected it")
        let store = makeStore(quantity: 1, service: service)
        store.quantity = 0

        let applied = await store.applyQuantity()

        XCTAssertNil(applied)
        XCTAssertTrue(store.quantityChanged)
        XCTAssertFalse(store.isOutOfStock, "an unconfirmed push must not badge out of stock")
        XCTAssertNotNil(store.actionError)
    }

    func test_applyQuantity_noOfferIdExplainsRepublish() async {
        let service = FakeService()
        service.quantityOutcome = .noOfferId
        let store = makeStore(quantity: 1, service: service)
        store.quantity = 2

        _ = await store.applyQuantity()

        XCTAssertEqual(
            store.actionError,
            "This listing has no eBay offer to update. Republish it to enable edits."
        )
    }

    // MARK: - End listing (AC2)

    func test_endListing_cleanWithdrawReportsEnded() async {
        let service = FakeService()
        let store = makeStore(quantity: 1, service: service)

        let applied = await store.endListing()

        XCTAssertEqual(applied, .ended(note: nil))
        XCTAssertEqual(service.endCalls, ["L1"])
        XCTAssertEqual(
            ListingMaintenanceControls.successToast(for: .ended(note: nil)),
            "Listing ended on eBay."
        )
    }

    func test_endListing_unconfirmedOnEbayCarriesTheHedgeIntoTheToast() async {
        // US-1506: eBay didn't withdraw it — never report a clean success.
        let service = FakeService()
        service.endOutcome = .ended(
            EndListingResponse(
                ok: true, listingId: "L1", endedOnEbay: false, note: "eBay showed it inactive."
            )
        )
        let store = makeStore(quantity: 1, service: service)

        let applied = await store.endListing()

        XCTAssertEqual(applied, .ended(note: "eBay showed it inactive."))
        XCTAssertEqual(
            ListingMaintenanceControls.successToast(for: applied!),
            "eBay showed it inactive."
        )
    }

    func test_endListing_unconfirmedWithNoServerNoteStillHedges() async {
        let service = FakeService()
        service.endOutcome = .ended(
            EndListingResponse(ok: true, listingId: "L1", endedOnEbay: false, note: nil)
        )
        let store = makeStore(quantity: 1, service: service)

        let applied = await store.endListing()
        guard case .ended(let note)? = applied else {
            return XCTFail("expected an ended outcome")
        }
        XCTAssertNotNil(note, "an unconfirmed end must not fall back to clean-success copy")
    }

    func test_endListing_planLimitSurfacesUpgradeCopy() async {
        let service = FakeService()
        service.endOutcome = .planLimit(message: "You've reached your plan's limit.")
        let store = makeStore(quantity: 1, service: service)

        let applied = await store.endListing()
        XCTAssertNil(applied)
        XCTAssertEqual(store.actionError, "You've reached your plan's limit.")
    }

    // MARK: - Toast copy (AC4)

    func test_successToast_distinguishesOutOfStockFromACount() {
        XCTAssertEqual(
            ListingMaintenanceControls.successToast(for: .quantity(0)),
            "Marked out of stock on eBay."
        )
        XCTAssertEqual(
            ListingMaintenanceControls.successToast(for: .quantity(3)),
            "Quantity updated to 3 on eBay."
        )
    }
}
