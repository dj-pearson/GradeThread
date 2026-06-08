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
    }

    func test_category_allCases_listsAll() {
        XCTAssertEqual(NotificationCategoryID.allCases.count, 10)
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

    // MARK: - US-679 expanded routing

    func test_deepLink_payoutPosted_routesToSales() {
        XCTAssertEqual(
            DeepLinkRoute.from(category: "payout.posted", userInfo: [:]),
            .salesTab(inventoryItemId: nil))
    }

    func test_deepLink_offerAndMessage_routeToMarketplacesWithoutItem() {
        XCTAssertEqual(DeepLinkRoute.from(category: "offer.received", userInfo: [:]), .marketplacesTab)
        XCTAssertEqual(DeepLinkRoute.from(category: "message.received", userInfo: [:]), .marketplacesTab)
    }

    func test_deepLink_offer_withItemId_routesToItem() {
        XCTAssertEqual(
            DeepLinkRoute.from(category: "offer.received", userInfo: ["inventory_item_id": "i9"]),
            .inventoryItem(id: "i9"))
    }

    func test_deepLink_agingDigest_routesToInventoryTab() {
        XCTAssertEqual(DeepLinkRoute.from(category: "aging.digest", userInfo: [:]), .inventoryTab)
    }

    func test_deepLink_listingEnded_itemElseInventoryTab() {
        XCTAssertEqual(
            DeepLinkRoute.from(category: "listing.ended", userInfo: ["inventory_item_id": "i1"]),
            .inventoryItem(id: "i1"))
        XCTAssertEqual(DeepLinkRoute.from(category: "listing.ended", userInfo: [:]), .inventoryTab)
    }

    // MARK: - PushService.environmentName

    func test_pushService_environmentName_matchesBuildConfig() {
        #if DEBUG
        XCTAssertEqual(PushService.environmentName, "development")
        #else
        XCTAssertEqual(PushService.environmentName, "production")
        #endif
    }
}
