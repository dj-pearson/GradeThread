import Foundation
import UIKit
import UserNotifications

/// `UNUserNotificationCenterDelegate` that handles two things:
///   1. Foreground presentation — when a push arrives while the app is
///      active, the system asks us how to display it. We allow banner +
///      sound so the user sees the same UX as background delivery.
///   2. Tap handling — on user tap, we extract the deep-link route from
///      the payload and forward to ``DeepLinkRouter`` which the App
///      observes via NotificationCenter.
public final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {

    public override init() { super.init() }

    // Apple calls these on the main thread already; we don't need
    // @MainActor isolation on the class.

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .badge, .sound, .list])
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let payload = response.notification.request.content
        let route = DeepLinkRoute.from(
            category: payload.categoryIdentifier,
            userInfo: payload.userInfo
        )
        if let route {
            DeepLinkRouter.post(route)
        }
        completionHandler()
    }
}

/// Routes a notification tap brings us to. The category identifier
/// drives the destination; per-payload `userInfo` carries the row id
/// when there's something specific to open.
public enum DeepLinkRoute: Equatable {
    case salesTab(inventoryItemId: String?)
    case marketplacesTab
    case inventoryItem(id: String)
    /// Opens the Inventory list (no specific row) — used by the aging-stock
    /// digest (US-679) so the tap lands on triage.
    case inventoryTab
    /// Opens the best-offers + buyer-messages inbox (US-999), filtered to a
    /// specific item when the push carried one.
    case negotiationInbox(filterItemId: String?)
    /// Opens the Grades list — used when a grade-ready push has no item id so
    /// the tap still lands somewhere useful (US-999).
    case gradesList

    /// Builds a route from the push payload. Returns nil when the
    /// category isn't one we know how to handle.
    public static func from(
        category: String,
        userInfo: [AnyHashable: Any]
    ) -> DeepLinkRoute? {
        let itemId = userInfo["inventory_item_id"] as? String
        switch category {
        case NotificationCategoryID.saleCreated.rawValue,
             NotificationCategoryID.payoutCleared.rawValue,
             NotificationCategoryID.payoutPosted.rawValue:
            return .salesTab(inventoryItemId: itemId)
        case NotificationCategoryID.tokenExpiring.rawValue:
            // Reconnect prompt → the Marketplaces surface where the account lives.
            return .marketplacesTab
        case NotificationCategoryID.offerReceived.rawValue,
             NotificationCategoryID.messageReceived.rawValue:
            // Offers + buyer messages open the Negotiation inbox; filter to the
            // referenced item when the push carried one.
            return .negotiationInbox(filterItemId: itemId)
        case NotificationCategoryID.agingDigest.rawValue:
            // Digest is a summary across many items → open the triage list.
            return .inventoryTab
        case NotificationCategoryID.listingEnded.rawValue:
            // Relist prompt → open the specific item if we have it, else triage.
            if let itemId { return .inventoryItem(id: itemId) }
            return .inventoryTab
        case NotificationCategoryID.gradeReady.rawValue:
            // Open the item's canvas when targeted; otherwise the Grades list so
            // the tap always lands somewhere useful instead of being a no-op.
            if let itemId { return .inventoryItem(id: itemId) }
            return .gradesList
        case NotificationCategoryID.itemReviewNeeded.rawValue:
            // The flagged item's canvas when we have it, else the review queue
            // (which surfaces on the Money/Sales tab).
            if let itemId { return .inventoryItem(id: itemId) }
            return .salesTab(inventoryItemId: nil)
        default:
            return nil
        }
    }
}

/// Tiny NotificationCenter-backed bus so the AppDelegate-owned
/// `NotificationDelegate` can hand the route to the SwiftUI layer
/// without needing a direct AppRouter handle (which lives inside
/// MainShell). ContentView listens for these and forwards to AppRouter.
public enum DeepLinkRouter {
    public static let notificationName = Notification.Name("com.gradethread.app.deepLink")
    public static let routeUserInfoKey = "route"

    public static func post(_ route: DeepLinkRoute) {
        NotificationCenter.default.post(
            name: notificationName,
            object: nil,
            userInfo: [routeUserInfoKey: route]
        )
    }
}
