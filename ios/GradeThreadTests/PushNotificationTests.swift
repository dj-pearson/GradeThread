import XCTest
@testable import GradeThread

@MainActor
final class PushNotificationTests: XCTestCase {

    // MARK: - NotificationCategoryID

    func test_category_rawValues_pinnedToWireStrings() {
        // The server stamps `categoryIdentifier` with these exact
        // strings — renaming any of them breaks tap-handling on every
        // already-installed app.
        XCTAssertEqual(NotificationCategoryID.saleCreated.rawValue, "sale.created")
        XCTAssertEqual(NotificationCategoryID.payoutCleared.rawValue, "payout.cleared")
        XCTAssertEqual(NotificationCategoryID.tokenExpiring.rawValue, "token.expiring")
        XCTAssertEqual(NotificationCategoryID.itemReviewNeeded.rawValue, "item.review_needed")
        XCTAssertEqual(NotificationCategoryID.gradeReady.rawValue, "grade.ready")
        // US-679 expanded categories.
        XCTAssertEqual(NotificationCategoryID.offerReceived.rawValue, "offer.received")
        XCTAssertEqual(NotificationCategoryID.messageReceived.rawValue, "message.received")
        XCTAssertEqual(NotificationCategoryID.listingEnded.rawValue, "listing.ended")
        XCTAssertEqual(NotificationCategoryID.agingDigest.rawValue, "aging.digest")
        XCTAssertEqual(NotificationCategoryID.payoutPosted.rawValue, "payout.posted")
        // US-1136 support replies.
        XCTAssertEqual(NotificationCategoryID.supportReply.rawValue, "support.reply")
    }

    func test_category_allCases_listsAll() {
        XCTAssertEqual(NotificationCategoryID.allCases.count, 11)
    }

    func test_category_labelsAreUserReadable() {
        for id in NotificationCategoryID.allCases {
            XCTAssertFalse(id.label.isEmpty, "\(id) missing label")
            XCTAssertFalse(id.helpText.isEmpty, "\(id) missing helpText")
        }
    }

    // MARK: - DeepLinkRoute.from

    func test_deepLink_saleCreated_includesItemIdWhenPresent() {
        let route = DeepLinkRoute.from(
            category: "sale.created",
            userInfo: ["inventory_item_id": "item-123"]
        )
        XCTAssertEqual(route, .salesTab(inventoryItemId: "item-123"))
    }

    func test_deepLink_saleCreated_nilItemId_stillRoutesToSales() {
        let route = DeepLinkRoute.from(
            category: "sale.created",
            userInfo: [:]
        )
        XCTAssertEqual(route, .salesTab(inventoryItemId: nil))
    }

    func test_deepLink_payoutCleared_routesToSales() {
        let route = DeepLinkRoute.from(
            category: "payout.cleared",
            userInfo: [:]
        )
        XCTAssertEqual(route, .salesTab(inventoryItemId: nil))
    }

    func test_deepLink_tokenExpiring_routesToMarketplaces() {
        let route = DeepLinkRoute.from(
            category: "token.expiring",
            userInfo: [:]
        )
        XCTAssertEqual(route, .marketplacesTab)
    }

    func test_deepLink_itemReviewNeeded_withItemId_routesToItem() {
        let route = DeepLinkRoute.from(
            category: "item.review_needed",
            userInfo: ["inventory_item_id": "item-42"]
        )
        XCTAssertEqual(route, .inventoryItem(id: "item-42"))
    }

    func test_deepLink_itemReviewNeeded_withoutItemId_fallsBackToSales() {
        let route = DeepLinkRoute.from(
            category: "item.review_needed",
            userInfo: [:]
        )
        XCTAssertEqual(route, .salesTab(inventoryItemId: nil))
    }

    func test_deepLink_unknownCategory_returnsNil() {
        XCTAssertNil(DeepLinkRoute.from(category: "marketing.promo", userInfo: [:]))
        XCTAssertNil(DeepLinkRoute.from(category: "", userInfo: [:]))
    }

    // US-1159: a malformed/garbage payload (wrong types, junk keys) must not
    // crash — the `as? String` casts fail gracefully and the route falls back to
    // its no-item destination.
    func test_deepLink_malformedPayload_doesNotCrash_fallsBack() {
        let garbage: [AnyHashable: Any] = [
            "inventory_item_id": 12345,            // Int, not String
            "support_ticket_id": ["nested": true], // wrong type
            42: "unexpected key type",
        ]
        // gradeReady with a non-string item id → falls back to the Grades list.
        XCTAssertEqual(
            DeepLinkRoute.from(category: "grade.ready", userInfo: garbage),
            .gradesList)
        // supportReply with a non-string ticket id → inbox (nil ticket).
        XCTAssertEqual(
            DeepLinkRoute.from(category: "support.reply", userInfo: garbage),
            .supportTickets(ticketId: nil))
    }

    // MARK: - US-679 expanded routing

    func test_deepLink_payoutPosted_routesToSales() {
        XCTAssertEqual(
            DeepLinkRoute.from(category: "payout.posted", userInfo: [:]),
            .salesTab(inventoryItemId: nil))
    }

    func test_deepLink_offerAndMessage_openNegotiationInboxWithoutItem() {
        // US-999: offers/messages now open the Negotiation inbox (was the
        // Marketplaces tab root), unfiltered when no item id is present.
        XCTAssertEqual(
            DeepLinkRoute.from(category: "offer.received", userInfo: [:]),
            .negotiationInbox(filterItemId: nil))
        XCTAssertEqual(
            DeepLinkRoute.from(category: "message.received", userInfo: [:]),
            .negotiationInbox(filterItemId: nil))
    }

    func test_deepLink_offer_withItemId_filtersNegotiationInbox() {
        // US-999: with an item id, the inbox opens filtered to that item rather
        // than diverting to the item canvas.
        XCTAssertEqual(
            DeepLinkRoute.from(category: "offer.received", userInfo: ["inventory_item_id": "i9"]),
            .negotiationInbox(filterItemId: "i9"))
    }

    func test_deepLink_tokenExpiring_stillRoutesToMarketplaces() {
        // Splitting offers/messages off must leave token.expiring on the tab.
        XCTAssertEqual(
            DeepLinkRoute.from(category: "token.expiring", userInfo: [:]),
            .marketplacesTab)
    }

    // MARK: - US-999 grade-ready fallback

    func test_deepLink_gradeReady_withItemId_routesToItem() {
        XCTAssertEqual(
            DeepLinkRoute.from(category: "grade.ready", userInfo: ["inventory_item_id": "g7"]),
            .inventoryItem(id: "g7"))
    }

    func test_deepLink_gradeReady_withoutItemId_fallsBackToGradesList() {
        // Was a no-op tap (returned nil); now lands on the Grades list.
        XCTAssertEqual(
            DeepLinkRoute.from(category: "grade.ready", userInfo: [:]),
            .gradesList)
    }

    func test_deepLink_everyKnownCategory_resolvesToARoute() {
        // AC: no notification category may resolve to a no-op tap.
        for id in NotificationCategoryID.allCases {
            XCTAssertNotNil(
                DeepLinkRoute.from(category: id.rawValue, userInfo: [:]),
                "\(id.rawValue) resolved to a no-op tap")
        }
    }

    func test_deepLink_agingDigest_routesToInventoryTab() {
        XCTAssertEqual(DeepLinkRoute.from(category: "aging.digest", userInfo: [:]), .inventoryTab)
    }

    // MARK: - US-1136 support replies

    func test_deepLink_supportReply_withTicketId_opensThread() {
        XCTAssertEqual(
            DeepLinkRoute.from(category: "support.reply", userInfo: ["support_ticket_id": "t-7"]),
            .supportTickets(ticketId: "t-7"))
    }

    func test_deepLink_supportReply_withoutTicketId_opensInbox() {
        XCTAssertEqual(
            DeepLinkRoute.from(category: "support.reply", userInfo: [:]),
            .supportTickets(ticketId: nil))
    }

    func test_deepLink_listingEnded_itemElseInventoryTab() {
        XCTAssertEqual(
            DeepLinkRoute.from(category: "listing.ended", userInfo: ["inventory_item_id": "i1"]),
            .inventoryItem(id: "i1"))
        XCTAssertEqual(DeepLinkRoute.from(category: "listing.ended", userInfo: [:]), .inventoryTab)
    }

    // MARK: - US-1133 inline notification actions

    func test_actionID_rawValues_pinnedToWireStrings() {
        // The action identifier is matched against `response.actionIdentifier`;
        // renaming breaks the button on installed apps.
        XCTAssertEqual(NotificationActionID.acceptOffer.rawValue, "offer.accept")
        XCTAssertEqual(NotificationActionID.counterOffer.rawValue, "offer.counter")
        XCTAssertEqual(NotificationActionID.markShipped.rawValue, "order.mark_shipped")
        XCTAssertEqual(NotificationActionID.reconnectEbay.rawValue, "ebay.reconnect")
    }

    func test_actionID_textInput_onlyCounterAndShip() {
        XCTAssertNotNil(NotificationActionID.counterOffer.textInput)
        XCTAssertNotNil(NotificationActionID.markShipped.textInput)
        XCTAssertNil(NotificationActionID.acceptOffer.textInput)
        XCTAssertNil(NotificationActionID.reconnectEbay.textInput)
    }

    func test_actionID_reconnect_isForeground() {
        // OAuth needs the app foregrounded; the others act headlessly.
        XCTAssertTrue(NotificationActionID.reconnectEbay.options.contains(.foreground))
        XCTAssertFalse(NotificationActionID.acceptOffer.options.contains(.foreground))
        XCTAssertFalse(NotificationActionID.markShipped.options.contains(.foreground))
    }

    func test_category_actions_onlyLiveCategoriesGetButtons() {
        XCTAssertEqual(NotificationCategoryID.offerReceived.actions, [.acceptOffer, .counterOffer])
        XCTAssertEqual(NotificationCategoryID.saleCreated.actions, [.markShipped])
        XCTAssertEqual(NotificationCategoryID.tokenExpiring.actions, [.reconnectEbay])
    }

    func test_category_actions_unsentCategoriesHaveNoButtons() {
        // AC: actions are hidden where the backend send isn't live yet.
        for id in [NotificationCategoryID.gradeReady, .messageReceived,
                   .listingEnded, .agingDigest, .payoutPosted,
                   .payoutCleared, .itemReviewNeeded] {
            XCTAssertTrue(id.actions.isEmpty, "\(id.rawValue) should have no inline actions")
        }
    }

    // MARK: - NotificationActionPlan.from

    func test_plan_unknownAction_isNone() {
        XCTAssertEqual(
            NotificationActionPlan.from(actionIdentifier: "bogus", userInfo: [:], userText: nil),
            .none)
    }

    func test_plan_reconnect_alwaysReconnects() {
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: "ebay.reconnect", userInfo: [:], userText: nil),
            .reconnect)
    }

    func test_plan_acceptOffer_withIds_acceptsHeadlessly() {
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: "offer.accept",
                userInfo: ["best_offer_id": "bo1", "inventory_item_id": "i1"],
                userText: nil),
            .acceptOffer(bestOfferId: "bo1", itemId: "i1"))
    }

    func test_plan_acceptOffer_missingIds_fallsBackToInbox() {
        // Backend send doesn't carry ids yet → degrade to opening the inbox.
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: "offer.accept",
                userInfo: ["inventory_item_id": "i1"],
                userText: nil),
            .deepLink(.negotiationInbox(filterItemId: "i1")))
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: "offer.accept", userInfo: [:], userText: nil),
            .deepLink(.negotiationInbox(filterItemId: nil)))
    }

    func test_plan_counterOffer_parsesTypedPrice() {
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: "offer.counter",
                userInfo: ["best_offer_id": "bo1", "inventory_item_id": "i1"],
                userText: "$42.50"),
            .counterOffer(bestOfferId: "bo1", itemId: "i1", price: 42.5))
    }

    func test_plan_counterOffer_noPrice_fallsBackToInbox() {
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: "offer.counter",
                userInfo: ["best_offer_id": "bo1", "inventory_item_id": "i1"],
                userText: "   "),
            .deepLink(.negotiationInbox(filterItemId: "i1")))
    }

    func test_plan_markShipped_withSaleId_andTracking() {
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: "order.mark_shipped",
                userInfo: ["sale_id": "s9"],
                userText: "1Z999"),
            .markShipped(saleId: "s9", tracking: "1Z999"))
    }

    func test_plan_markShipped_blankTracking_isNil() {
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: "order.mark_shipped",
                userInfo: ["sale_id": "s9"],
                userText: "  "),
            .markShipped(saleId: "s9", tracking: nil))
    }

    func test_plan_markShipped_missingSaleId_fallsBackToSales() {
        XCTAssertEqual(
            NotificationActionPlan.from(
                actionIdentifier: "order.mark_shipped",
                userInfo: ["inventory_item_id": "i1"],
                userText: "1Z999"),
            .deepLink(.salesTab(inventoryItemId: "i1")))
    }

    func test_plan_parsePrice_tolerantOfFormatting() {
        XCTAssertEqual(NotificationActionPlan.parsePrice("$1,234.56"), 1234.56)
        XCTAssertNil(NotificationActionPlan.parsePrice("abc"))
        XCTAssertNil(NotificationActionPlan.parsePrice(nil))
    }

    // MARK: - PushService.environmentName

    func test_pushService_environmentName_matchesBuildConfig() {
        #if DEBUG
        XCTAssertEqual(PushService.environmentName, "development")
        #else
        XCTAssertEqual(PushService.environmentName, "production")
        #endif
    }

    // MARK: - US-1000: edge-registration retry

    /// The hardcoded UserDefaults key PushService persists its cached hex token
    /// under (kept private on PushService; mirrored here for the test seam).
    private static let cachedTokenKey = "com.gradethread.app.push.tokenHex"

    /// Builds a PushService backed by an isolated UserDefaults suite and a fake
    /// sender, optionally pre-seeding a cached (but unconfirmed) token.
    private func makeService(
        cachedToken: String?,
        sender: FakeRegisterSender
    ) -> PushService {
        let suite = "test.push.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        if let cachedToken {
            defaults.set(cachedToken, forKey: Self.cachedTokenKey)
        }
        return PushService(
            defaults: defaults,
            registerSender: { try await sender.send($0, $1) }
        )
    }

    func test_retry_after500_reRegistersAndReachesRegistered() async {
        let sender = FakeRegisterSender()
        sender.failFirstN = 1
        let service = makeService(cachedToken: "abc123", sender: sender)

        // First attempt hits a transient edge 500 → registration fails, but the
        // cached token is retained for a later retry.
        let firstSent = await service.retryRegistrationIfNeeded()
        XCTAssertTrue(firstSent)
        guard case .registrationFailed = service.phase else {
            return XCTFail("Expected registrationFailed, got \(service.phase)")
        }

        // Next launch/reconnect re-POSTs the cached token; the edge succeeds.
        let secondSent = await service.retryRegistrationIfNeeded()
        XCTAssertTrue(secondSent)
        XCTAssertEqual(service.phase, .registered(deviceToken: "abc123"))
        XCTAssertEqual(sender.callCount, 2)
        XCTAssertEqual(sender.lastToken, "abc123")
    }

    func test_retry_afterSuccess_isIdempotent_noFurtherSend() async {
        let sender = FakeRegisterSender()
        let service = makeService(cachedToken: "tok", sender: sender)

        let first = await service.retryRegistrationIfNeeded()
        XCTAssertTrue(first)
        XCTAssertEqual(service.phase, .registered(deviceToken: "tok"))
        XCTAssertEqual(sender.callCount, 1)

        // A confirmed token must not be re-POSTed on subsequent launches.
        let second = await service.retryRegistrationIfNeeded()
        XCTAssertFalse(second)
        XCTAssertEqual(sender.callCount, 1)
    }

    func test_retry_withNoCachedToken_doesNothing() async {
        let sender = FakeRegisterSender()
        let service = makeService(cachedToken: nil, sender: sender)

        let sent = await service.retryRegistrationIfNeeded()
        XCTAssertFalse(sent)
        XCTAssertEqual(sender.callCount, 0)
        XCTAssertEqual(service.phase, .unknown)
    }

    func test_initialPhase_cachedButUnconfirmedToken_isPendingRetry() async {
        // A token cached on a prior launch but never confirmed by the edge must
        // not present as `.registered` — otherwise the launch-time retry would
        // skip it and the device stays silently unregistered.
        let sender = FakeRegisterSender()
        let service = makeService(cachedToken: "pending", sender: sender)
        guard case .registering = service.phase else {
            return XCTFail("Expected registering, got \(service.phase)")
        }

        let sent = await service.retryRegistrationIfNeeded()
        XCTAssertTrue(sent)
        XCTAssertEqual(service.phase, .registered(deviceToken: "pending"))
    }
}

/// Fake edge sender for PushService retry tests: counts calls and can fail the
/// first N attempts to simulate a transient 500 followed by success.
final class FakeRegisterSender: @unchecked Sendable {
    private(set) var callCount = 0
    private(set) var lastToken: String?
    private(set) var lastEnvironment: String?
    var failFirstN = 0

    func send(_ tokenHex: String, _ environment: String) async throws {
        callCount += 1
        lastToken = tokenHex
        lastEnvironment = environment
        if callCount <= failFirstN {
            throw EdgeAPIError.serverError(detail: "simulated transient 500")
        }
    }
}
