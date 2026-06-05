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

    /// Builds a route from the push payload. Returns nil when the
    /// category isn't one we know how to handle.
    public static func from(
        category: String,
        userInfo: [AnyHashable: Any]
    ) -> DeepLinkRoute? {
        let itemId = userInfo["inventory_item_id"] as? String
        switch category {
        case NotificationCategoryID.saleCreated.rawValue,
             NotificationCategoryID.payoutCleared.rawValue:
            return .salesTab(inventoryItemId: itemId)
        case NotificationCategoryID.tokenExpiring.rawValue:
            return .marketplacesTab
        case NotificationCategoryID.gradeReady.rawValue,
             NotificationCategoryID.itemReviewNeeded.rawValue:
            // Open the specific item's canvas (its certified-grade report
            // lives there). Without an id we can't target a row, so ignore.
            if let itemId {
                return .inventoryItem(id: itemId)
            }
            return category == NotificationCategoryID.itemReviewNeeded.rawValue
                ? .salesTab(inventoryItemId: nil)
                : nil
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
