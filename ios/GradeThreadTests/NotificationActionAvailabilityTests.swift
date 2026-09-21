import XCTest
@testable import GradeThread

/// Five of the six inline notification buttons could not do the thing they
/// offered, and US-3275 gave three of them back.
///
/// US-1133 declared Accept and Counter on an offer push and Mark shipped on a
/// sale push, with a comment saying no dead button is ever shown. The test it
/// applied was whether the CATEGORY's send was live. The question that mattered
/// is whether the PAYLOAD carries the ids the ACTION needs, and every sender in
/// transactional-push.ts shipped `data: { kind }` and nothing else.
///
/// So a seller saw Accept on an offer, got a Face ID prompt (accept and counter
/// are authenticationRequired because they move money), and then the app opened
/// on the inbox with nothing accepted. They authenticated for nothing.
///
/// US-3275 stamps best_offer_id, inventory_item_id and sale_id, so the filter
/// in `actions` now lets those three through on their own.
final class NotificationActionAvailabilityTests: XCTestCase {

    /// What the edge stamps per category, READ FROM `contracts/push-contract.json`.
    ///
    /// ⚠ THIS USED TO BE A HAND-WRITTEN TABLE, and a key added here that the
    /// edge does not send re-enables a dead button -- which is the whole
    /// defect. US-3279 replaced it with the generated artefact, so the two
    /// sides cannot disagree without a Deno test
    /// (`push-contract_test.ts`) failing as well.
    private static func keys(for category: NotificationCategoryID) -> Set<String> {
        PushContract.payloadKeys(for: category.rawValue)
    }

    func test_noRegisteredActionAsksForSomethingThePayloadDoesNotCarry() {
        for category in NotificationCategoryID.allCases {
            for action in category.actions {
                XCTAssertTrue(
                    action.requiredPayloadKeys.isSubset(of: Self.keys(for: category)),
                    "\(category.rawValue) registers \(action.rawValue), which needs "
                        + "\(action.requiredPayloadKeys.sorted()) and the edge does not send it"
                )
            }
        }
    }

    func test_payloadKeysMatchesWhatTheEdgeSends() {
        // US-3279: the app target cannot read a repo file at runtime, so
        // `payloadKeys` stays written out in NotificationActions.swift and
        // this is what checks it against the generated artefact. Drift here is
        // what would silently re-enable a button, so it is asserted rather
        // than assumed.
        for category in NotificationCategoryID.allCases {
            XCTAssertEqual(
                category.payloadKeys,
                Self.keys(for: category),
                "\(category.rawValue) payloadKeys disagrees with the edge"
            )
        }
    }

    func test_theThreeButtonsAreBackAndTheRestStayHidden() {
        // US-3275: the ids arrived, so the filter lets these through.
        XCTAssertEqual(
            NotificationCategoryID.offerReceived.actions,
            [.acceptOffer, .counterOffer]
        )
        XCTAssertEqual(NotificationCategoryID.saleCreated.actions, [.markShipped])
        XCTAssertEqual(NotificationCategoryID.tokenExpiring.actions, [.reconnectEbay])
        XCTAssertEqual(NotificationActionID.reconnectEbay.requiredPayloadKeys, [])
    }

    func test_aCategoryWithNoIdsStillRegistersNothing() {
        // The filter has to keep working, or the next declared action lands on
        // a payload that cannot serve it.
        for category in NotificationCategoryID.allCases
        where Self.keys(for: category) == ["kind"] {
            for action in category.actions {
                XCTAssertTrue(
                    action.requiredPayloadKeys.isEmpty,
                    "\(category.rawValue) registers \(action.rawValue) on a bare payload"
                )
            }
        }
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
