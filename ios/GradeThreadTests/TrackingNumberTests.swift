import XCTest
@testable import GradeThread

/// "Mark shipped" has two entry points and only one of them checked what was
/// typed.
///
/// `MarkShippedSheet` has warned about an obviously-malformed tracking number
/// since US-1178. The notification action takes free text from the lock screen,
/// trimmed it, and handed anything non-empty to `FulfillmentService`, which
/// pushes a non-empty tracking straight to eBay's shipping_fulfillment. No
/// sheet, no warning, no confirmation, and an eBay fulfillment cannot be edited
/// afterwards - the buyer just gets a tracking link that goes nowhere.
final class TrackingNumberTests: XCTestCase {

    // MARK: - The rule

    func test_arealTrackingNumberIsPlausible() {
        XCTAssertTrue(TrackingNumber.isPlausible("9400100000000000000000"))
        XCTAssertTrue(TrackingNumber.isPlausible("1Z999AA10123456784"))
    }

    func test_aNumberFormattedForReadingIsAccepted() {
        // Carrier sites space these out, and that is what gets pasted. The old
        // in-sheet rule rejected the spaces and warned about a real number.
        XCTAssertTrue(TrackingNumber.isPlausible("9400 1000 0000 0000 0000 00"))
        XCTAssertTrue(TrackingNumber.isPlausible("1Z999-AA10-1234-5678"))
    }

    func test_aSentenceIsNotATrackingNumber() {
        // The notification field is labelled "Tracking number (optional)" and
        // this is what people type into it anyway.
        XCTAssertFalse(TrackingNumber.isPlausible("will do tomorrow"))
        XCTAssertFalse(TrackingNumber.isPlausible("n/a"))
        XCTAssertFalse(TrackingNumber.isPlausible("shipped!"))
    }

    func test_tooShortAndTooLongAreRejected() {
        XCTAssertFalse(TrackingNumber.isPlausible("1234567"), "seven is short of every carrier")
        XCTAssertTrue(TrackingNumber.isPlausible("12345678"))
        XCTAssertTrue(TrackingNumber.isPlausible(String(repeating: "A", count: 40)))
        XCTAssertFalse(TrackingNumber.isPlausible(String(repeating: "A", count: 41)))
    }

    func test_emptyIsNotPlausible() {
        // Empty means "ship without tracking", which is a choice the caller
        // handles. It is not a tracking number.
        XCTAssertFalse(TrackingNumber.isPlausible(""))
        XCTAssertFalse(TrackingNumber.isPlausible("   "))
    }

    func test_normalizedKeepsOnlyWhatTheCarrierCaresAbout() {
        XCTAssertEqual(TrackingNumber.normalized("9400 1000 0000"), "940010000000")
        XCTAssertEqual(TrackingNumber.normalized("1Z999-AA10"), "1Z999AA10")
    }

    // MARK: - The notification action

    private func plan(_ typed: String?, saleId: String? = "sale-1") -> NotificationActionPlan {
        var info: [AnyHashable: Any] = ["inventory_item_id": "item-1"]
        if let saleId { info["sale_id"] = saleId }
        return NotificationActionPlan.from(
            actionIdentifier: NotificationActionID.markShipped.rawValue,
            userInfo: info,
            userText: typed
        )
    }

    func test_aPlausibleNumberShipsTheOrder() {
        XCTAssertEqual(
            plan("9400 1000 0000 0000 0000 00"),
            .markShipped(saleId: "sale-1", tracking: "9400 1000 0000 0000 0000 00")
        )
    }

    func test_shippingWithNoTrackingStillWorks() {
        XCTAssertEqual(plan(nil), .markShipped(saleId: "sale-1", tracking: nil))
        XCTAssertEqual(plan("   "), .markShipped(saleId: "sale-1", tracking: nil))
    }

    func test_somethingThatIsNotATrackingNumberOpensTheOrderInsteadOfShippingIt() {
        // The same answer counterOffer already gives an unparseable price: open
        // the place where it can be done properly. Marking it shipped WITHOUT
        // the number would be worse, because it buries the mistake under a
        // state the seller cannot see is incomplete.
        XCTAssertEqual(plan("will do tomorrow"), .deepLink(.salesTab(inventoryItemId: "item-1")))
        XCTAssertEqual(plan("n/a"), .deepLink(.salesTab(inventoryItemId: "item-1")))
    }

    func test_aPushWithNoSaleIdStillFallsBackToTheScreen() {
        XCTAssertEqual(
            plan("9400100000000000000000", saleId: nil),
            .deepLink(.salesTab(inventoryItemId: "item-1"))
        )
    }
}
