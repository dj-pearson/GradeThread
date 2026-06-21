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
        let actionId = response.actionIdentifier

        // A plain tap keeps the existing deep-link behavior; the system dismiss
        // is a no-op. Everything else is an inline action button (US-1133).
        if actionId == UNNotificationDefaultActionIdentifier {
            if let route = DeepLinkRoute.from(
                category: payload.categoryIdentifier,
                userInfo: payload.userInfo
            ) {
                DeepLinkRouter.post(route)
            }
            completionHandler()
            return
        }
        if actionId == UNNotificationDismissActionIdentifier {
            completionHandler()
            return
        }

        let typed = (response as? UNTextInputNotificationResponse)?.userText
        let plan = NotificationActionPlan.from(
            actionIdentifier: actionId,
            userInfo: payload.userInfo,
            userText: typed
        )
        Self.perform(plan, completionHandler: completionHandler)
    }

    /// Executes a resolved inline-action plan (US-1133). Network actions run the
    /// matching edge call off-main and only then signal completion so iOS keeps
    /// the brief background window alive; ``NotificationActionPlan/deepLink(_:)``
    /// and ``NotificationActionPlan/reconnect`` just route into the app (the
    /// reconnect button is `.foreground`, so the OAuth UI can present).
    static func perform(
        _ plan: NotificationActionPlan,
        completionHandler: @escaping () -> Void
    ) {
        switch plan {
        case .reconnect:
            DeepLinkRouter.post(.marketplacesTab)
            completionHandler()
        case let .deepLink(route):
            DeepLinkRouter.post(route)
            completionHandler()
        case .none:
            completionHandler()
        case let .acceptOffer(bestOfferId, itemId):
            runEdgeAction(label: NotificationActionID.acceptOffer.rawValue,
                          completionHandler: completionHandler) {
                try await NegotiationService().respond(
                    bestOfferId: bestOfferId, itemId: itemId,
                    action: "Accept", counterPrice: nil, message: nil)
            }
        case let .counterOffer(bestOfferId, itemId, price):
            runEdgeAction(label: NotificationActionID.counterOffer.rawValue,
                          completionHandler: completionHandler) {
                try await NegotiationService().respond(
                    bestOfferId: bestOfferId, itemId: itemId,
                    action: "Counter", counterPrice: price, message: nil)
            }
        case let .markShipped(saleId, tracking):
            runEdgeAction(label: NotificationActionID.markShipped.rawValue,
                          completionHandler: completionHandler) {
                try await FulfillmentService().markShipped(
                    saleId: saleId, trackingNumber: tracking, shippedAt: Date())
            }
        }
    }

    /// Runs an async edge call for an inline action, instruments the outcome,
    /// and signals completion regardless of success — a failed accept/ship must
    /// never strand the system's background handler.
    private static func runEdgeAction(
        label: String,
        completionHandler: @escaping () -> Void,
        _ operation: @escaping @Sendable () async throws -> Void
    ) {
        Task {
            var ok = true
            do {
                try await operation()
            } catch {
                ok = false
            }
            await MainActor.run {
                Telemetry.event(
                    "notification_action",
                    props: ["action": label, "result": ok ? "ok" : "error"])
                if !ok {
                    Telemetry.breadcrumb(
                        "notification action \(label) failed", category: "notifications")
                }
            }
            completionHandler()
        }
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
    /// US-1134: "Snap to value" Siri/Shortcut → straight into the photo-first
    /// capture-and-grade flow. No push uses this; it's driven by App Intents.
    case captureItem
    /// US-1134: "Add an item" Siri/Shortcut → the add-method chooser. App Intents
    /// only.
    case addItem
    /// US-1136: a support reply push opens the native ticket inbox — straight
    /// into the referenced thread when the payload carried its id.
    case supportTickets(ticketId: String?)

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
        case NotificationCategoryID.supportReply.rawValue:
            // US-1136: open the ticket thread directly when the push carried its
            // id; otherwise land on the support inbox list.
            return .supportTickets(ticketId: userInfo["support_ticket_id"] as? String)
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
