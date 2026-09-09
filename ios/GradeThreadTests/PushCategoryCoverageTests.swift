import XCTest
@testable import GradeThread

/// The edge sends a `categoryIdentifier` on every push. iOS decides three
/// things from it: where the tap goes, whether the user can mute it, and
/// whether it presents in the foreground. A category iOS does not know loses
/// the first two silently.
///
/// Seven of them had been shipping that way. `transactional-push.ts` sends
/// fourteen categories; `NotificationCategoryID` knew seven of them plus five
/// nobody sends. The unknown seven are the post-order family (returns,
/// inquiries, cases, case deadlines, cancellations, payment disputes) and the
/// offer reply, which is to say the pushes that carry a deadline.
///
/// This mirrors the sent list by hand for the same reason `ShareInboxTests`
/// mirrors the slot constants: the Deno service is not linked into this target.
/// A category added on the server without a line here is not caught, but a
/// category added here or removed from the enum is, and the mirror is the
/// place a reviewer will look.
final class PushCategoryCoverageTests: XCTestCase {

    /// Every `category:` literal in
    /// `services/edge-functions/src/lib/transactional-push.ts`.
    private static let sentByEdge: [String] = [
        "item.review_needed",
        "token.expiring",
        "sale.created",
        "listing.ended",
        "payout.cleared",
        "offer.received",
        "offer.responded",
        "return.opened",
        "inquiry.opened",
        "case.opened",
        "case.deadline",
        "cancellation.requested",
        "dispute.opened",
        "delist.needed",
    ]

    func test_everyCategoryTheEdgeSendsIsKnownToTheApp() {
        let known = Set(NotificationCategoryID.allCases.map(\.rawValue))
        let unknown = Self.sentByEdge.filter { !known.contains($0) }
        XCTAssertEqual(
            unknown, [],
            "the edge sends these and iOS does not recognise them, so the tap goes nowhere and Settings offers no toggle"
        )
    }

    func test_everyCategoryTheEdgeSendsRoutesSomewhere() {
        for category in Self.sentByEdge {
            XCTAssertNotNil(
                DeepLinkRoute.from(category: category, userInfo: [:]),
                "\(category) has no route, so tapping the push leaves the user wherever the app already was"
            )
        }
    }

    func test_thePostOrderFamilyLandsOnTheSectionItsPushNamed() {
        // US-3266. These used to land on `.marketplacesTab`, which is the tab
        // that HOLDS Returns & disputes and not the screen, so a seller with a
        // dispute deadline still had to find a card.
        let expected: [String: PostSaleSection] = [
            // eBay models an inquiry and a case as escalations of a
            // return-shaped claim, and PostSaleStore.returns is what holds them.
            "return.opened": .returns,
            "inquiry.opened": .returns,
            "case.opened": .returns,
            // The deadline reminder names no case and its payload carries no
            // id, so it opens where a case lives.
            "case.deadline": .returns,
            "cancellation.requested": .cancellations,
            "dispute.opened": .disputes,
        ]
        for (category, section) in expected {
            XCTAssertEqual(
                DeepLinkRoute.from(category: category, userInfo: [:]),
                .postSale(section: section),
                "\(category) should open the \(section.rawValue) section"
            )
        }
    }

    func test_aPostSaleRouteSurvivesAColdLaunchWithItsSectionIntact() throws {
        for section in PostSaleSection.allCases {
            let route = DeepLinkRoute.postSale(section: section)
            let token = try XCTUnwrap(route.coldLaunchToken)
            XCTAssertEqual(DeepLinkRoute(coldLaunchToken: token), route)
        }
        // A section this build does not have is refused, not defaulted:
        // landing on Returns because "chargebacks" did not parse is a wrong
        // answer wearing a right one's clothes.
        XCTAssertNil(DeepLinkRoute(coldLaunchToken: "postSale|chargebacks"))
        XCTAssertNil(DeepLinkRoute(coldLaunchToken: "postSale"))
    }

    func test_anOfferReplyOpensTheSameInboxAsTheOffer() {
        XCTAssertEqual(
            DeepLinkRoute.from(
                category: "offer.responded",
                userInfo: ["inventory_item_id": "abc"]
            ),
            .negotiationInbox(filterItemId: "abc")
        )
        XCTAssertEqual(
            DeepLinkRoute.from(category: "offer.responded", userInfo: [:]),
            .negotiationInbox(filterItemId: nil)
        )
    }

    func test_everyKnownCategoryHasCopyForItsSettingsToggle() {
        // A category with no label is a blank row in Settings, which reads as a
        // bug rather than as a toggle.
        for category in NotificationCategoryID.allCases {
            XCTAssertFalse(category.label.isEmpty, "\(category.rawValue) has no label")
            XCTAssertFalse(category.helpText.isEmpty, "\(category.rawValue) has no help text")
        }
    }

    func test_anUnknownCategoryStillPresentsRatherThanBeingSwallowed() {
        // The forward-compatible half: a category the server adds tomorrow must
        // show up before iOS ships a toggle for it.
        XCTAssertTrue(NotificationPreferences.isEnabled(rawCategory: "something.new"))
        XCTAssertNil(DeepLinkRoute.from(category: "something.new", userInfo: [:]))
    }
}
