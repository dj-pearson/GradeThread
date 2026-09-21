import XCTest
@testable import GradeThread

/// The edge sends a `categoryIdentifier` on every push. iOS decides three
/// things from it: where the tap goes, whether the user can mute it, and
/// whether it presents in the foreground. A category iOS does not know loses
/// the first two silently.
///
/// Seven of them had been shipping that way (US-3266): the post-order family
/// (returns, inquiries, cases, case deadlines, cancellations, payment
/// disputes) and the offer reply, which is to say the pushes that carry a
/// deadline.
///
/// ⚠ THIS USED TO MIRROR THE SENT LIST BY HAND, and the mirror could only see
/// the file it was compiled with: a category added on the server was invisible
/// here. US-3279 made the edge generate `contracts/push-contract.json` from
/// its own senders, with a Deno test that fails when it is stale, and this
/// suite reads that. A change on either side now fails the other.
final class PushCategoryCoverageTests: XCTestCase {

    /// Every category the edge sends, read from `contracts/push-contract.json`.
    ///
    /// ⚠ THIS USED TO BE A LIST TYPED OUT BY HAND, and it could only catch
    /// drift on the iOS side: a category added on the server without a line
    /// here was invisible. US-3279 made the edge generate the artefact from
    /// `transactional-push.ts`, with a Deno test that fails when it is stale,
    /// so a change on either side now fails the other.
    private static var sentByEdge: [String] { PushContract.sentByEdge }

    func test_everyCategoryTheEdgeSendsIsKnownToTheApp() {
        let known = Set(NotificationCategoryID.allCases.map(\.rawValue))
        let unknown = Self.sentByEdge.filter { !known.contains($0) }
        XCTAssertEqual(
            unknown, [],
            "the edge sends these and iOS does not recognise them, so the tap goes nowhere and Settings offers no toggle"
        )
    }

    /// Categories whose tap deliberately just opens the app.
    ///
    /// A growth campaign is news about the product, not about a row: there is
    /// no screen it means. Naming it here rather than inventing a destination
    /// keeps the guard honest about the one case it does not cover.
    private static let noDestination: Set<String> = ["marketing"]

    func test_everyCategoryTheEdgeSendsRoutesSomewhere() {
        for category in Self.sentByEdge where !Self.noDestination.contains(category) {
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

    // MARK: - Toggles that govern something (US-3268)

    /// The categories iOS declares that the edge has no sender for.
    ///
    /// ⚠ DERIVED, NOT LISTED. US-3268 hid three toggles (message.received,
    /// aging.digest, payout.posted) for notifications nothing could send, and
    /// the list of them was written by hand beside the enum -- so the day a
    /// sender shipped, nothing said the flag was now wrong. It is now the
    /// difference between what iOS knows and what the artefact says is sent,
    /// which means shipping a sender is the only thing needed to shrink it.
    private static var undeliverable: Set<String> {
        let sent = Set(PushContract.sentByEdge)
            .union(NotificationCategoryID.locallyDelivered.map(\.rawValue))
        return Set(NotificationCategoryID.allCases.map(\.rawValue)).subtracting(sent)
    }

    func test_theOnlyCategoriesWithoutASenderAreTheOnesWeSayHaveNoSender() {
        let flagged = Set(
            NotificationCategoryID.allCases.filter { !$0.isDeliverable }.map(\.rawValue)
        )
        XCTAssertEqual(
            flagged, Self.undeliverable,
            "isDeliverable and this list disagree: either a sender shipped and the flag was not flipped, or a category was hidden without saying why"
        )
    }

    func test_everyCategoryTheEdgeSendsIsOfferedAsAToggle() {
        // The inverse guard. Something the edge demonstrably sends must never
        // be marked undeliverable, or the user loses the ability to mute a
        // push they are actually getting.
        let togglable = Set(NotificationCategoryID.togglable.map(\.rawValue))
        for category in Self.sentByEdge {
            XCTAssertTrue(
                togglable.contains(category),
                "\(category) is sent by the edge but Settings offers no way to turn it off"
            )
        }
    }

    func test_aCategoryWithNoToggleCanStillBeReceivedIfOneEverArrives() {
        // Hiding the toggle must not mute the push. The preference default is
        // ON and the routing stays wired, so the day a sender ships, the only
        // change needed is the flag.
        for category in Self.undeliverable {
            XCTAssertTrue(NotificationPreferences.isEnabled(rawCategory: category))
        }
        XCTAssertEqual(
            DeepLinkRoute.from(category: "message.received", userInfo: ["inventory_item_id": "z"]),
            .negotiationInbox(filterItemId: "z")
        )
        // US-3279 found a fourth: support.reply routes into the ticket thread
        // and nothing has ever sent it. The routing stays, the toggle goes.
        XCTAssertEqual(
            DeepLinkRoute.from(category: "support.reply", userInfo: ["support_ticket_id": "t1"]),
            .supportTickets(ticketId: "t1")
        )
    }

    func test_aLocallyDeliveredCategoryKeepsItsToggleWithoutAnEdgeSender() {
        // grade.ready is scheduled on-device by NewGradeNotifier. Deriving the
        // undeliverable set from the artefact alone would demand its toggle be
        // hidden, taking away a switch over a notification users do receive.
        XCTAssertFalse(PushContract.sentByEdge.contains("grade.ready"))
        XCTAssertTrue(NotificationCategoryID.gradeReady.isDeliverable)
        XCTAssertTrue(NotificationCategoryID.locallyDelivered.contains(.gradeReady))
    }

    func test_theGrowthCampaignPushIsKnownAndMutable() {
        // US-3279: routes/admin-growth.ts has pushed this category all along,
        // outside transactional-push.ts, so every audit that read that one file
        // missed it. Knowing it is what gives the user a way to turn it off.
        XCTAssertTrue(PushContract.sentByEdge.contains("marketing"))
        XCTAssertNotNil(NotificationCategoryID(rawValue: "marketing"))
        XCTAssertTrue(NotificationCategoryID.marketing.isDeliverable)
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
