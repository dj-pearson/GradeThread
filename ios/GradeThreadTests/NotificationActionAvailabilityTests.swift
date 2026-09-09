import XCTest
@testable import GradeThread

/// Five of the six inline notification buttons could not do the thing they
/// offered.
///
/// US-1133 declared Accept and Counter on an offer push and Mark shipped on a
/// sale push, with a comment saying no dead button is ever shown. The test it
/// applied was whether the CATEGORY's send was live. The question that mattered
/// is whether the PAYLOAD carries the ids the ACTION needs, and every sender in
/// transactional-push.ts ships `data: { kind }` and nothing else.
///
/// So a seller saw Accept on an offer, got a Face ID prompt (accept and counter
/// are authenticationRequired because they move money), and then the app opened
/// on the inbox with nothing accepted. They authenticated for nothing.
final class NotificationActionAvailabilityTests: XCTestCase {

    /// What the edge stamps today, mirrored by hand because the Deno service is
    /// not linked into this target. Every sender in transactional-push.ts sends
    /// `data: { kind: "..." }` and no ids.
    private static let keysSentByEdge: Set<String> = ["kind"]

    func test_noRegisteredActionAsksForSomethingThePayloadDoesNotCarry() {
        for category in NotificationCategoryID.allCases {
            for action in category.actions {
                XCTAssertTrue(
                    action.requiredPayloadKeys.isSubset(of: Self.keysSentByEdge),
                    "\(category.rawValue) registers \(action.rawValue), which needs "
                        + "\(action.requiredPayloadKeys.sorted()) and the edge sends none of it"
                )
            }
        }
    }

    func test_theOnlyButtonLeftIsTheOneThatNeedsNothing() {
        // Reconnect foregrounds the app and hands over to the connection card,
        // so it never depended on the payload. That is why it is the one that
        // always worked.
        XCTAssertEqual(NotificationCategoryID.tokenExpiring.actions, [.reconnectEbay])
        XCTAssertEqual(NotificationActionID.reconnectEbay.requiredPayloadKeys, [])
    }

    func test_theDeadButtonsAreHiddenRatherThanDeleted() {
        // The intent stays visible: the day the edge stamps the ids, the
        // category gets a payloadKeys case and its buttons come back.
        XCTAssertEqual(
            NotificationCategoryID.offerReceived.declaredActions,
            [.acceptOffer, .counterOffer]
        )
        XCTAssertEqual(NotificationCategoryID.offerReceived.actions, [])
        XCTAssertEqual(NotificationCategoryID.saleCreated.declaredActions, [.markShipped])
        XCTAssertEqual(NotificationCategoryID.saleCreated.actions, [])
    }

    func test_everyDeclaredActionStatesWhatItNeeds() {
        // A new action with no entry would default to needing nothing and get
        // registered on a payload that cannot serve it.
        XCTAssertEqual(
            NotificationActionID.acceptOffer.requiredPayloadKeys,
            ["best_offer_id", "inventory_item_id"]
        )
        XCTAssertEqual(
            NotificationActionID.counterOffer.requiredPayloadKeys,
            ["best_offer_id", "inventory_item_id"]
        )
        XCTAssertEqual(NotificationActionID.markShipped.requiredPayloadKeys, ["sale_id"])
    }

    func test_thePlanStillFallsBackSafelyIfAButtonEverArrivesWithoutIds() {
        // Belt and braces: hiding the button is the fix, but the plan builder
        // must keep refusing to fire a broken edge call.
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: NotificationActionID.acceptOffer.rawValue,
                userInfo: ["kind": "offer_received"],
                userText: nil
            ),
            .deepLink(.negotiationInbox(filterItemId: nil))
        )
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: NotificationActionID.markShipped.rawValue,
                userInfo: ["kind": "sale_created"],
                userText: "9400100000000000000000"
            ),
            .deepLink(.salesTab(inventoryItemId: nil))
        )
    }
}
