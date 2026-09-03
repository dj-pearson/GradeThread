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
        // US-1257: honor the per-category mute preference set in Settings. A
        // muted category presents nothing (no banner/badge/sound/list) so the
        // toggle isn't a no-op; an enabled or unknown category presents fully.
        completionHandler(
            Self.presentationOptions(
                forCategory: notification.request.content.categoryIdentifier))
    }

    /// Resolves foreground presentation options from the user's per-category
    /// notification preferences (US-1257). Pure + injectable so it's unit-tested
    /// without the system notification center.
    static func presentationOptions(
        forCategory rawCategory: String,
        defaults: UserDefaults = .standard
    ) -> UNNotificationPresentationOptions {
        guard NotificationPreferences.isEnabled(rawCategory: rawCategory, defaults: defaults) else {
            return []
        }
        return [.banner, .badge, .sound, .list]
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
            // US-1262: a "reconnect" action should actually START reconnection,
            // not just drop the user on the Marketplaces tab to hunt for the
            // button. `.reconnectEbay` lands on Marketplaces AND auto-presents the
            // eBay OAuth sheet. The action button is `.foreground`, so the app is
            // active by the time the route is applied and the OAuth UI can show.
            DeepLinkRouter.post(.reconnectEbay)
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
    /// US-1262: like ``marketplacesTab`` but also auto-presents the eBay
    /// OAuth/reconnect sheet on arrival, so a "reconnect" notification action is
    /// a one-tap path back into the connection flow rather than a dead end.
    case reconnectEbay
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
    /// US-3101: the sourcing camera, from a home-screen quick action, a Lock
    /// Screen widget, or Siri. No push uses it — a seller reaches for Prospect
    /// standing in front of a rack, which is exactly when hunting for a grid
    /// icon inside Tools costs them the aisle.
    case prospect
    /// US-3101: the deal finder, from a home-screen quick action.
    case scout
    /// US-3101: Inventory, filtered to drafts waiting to be published.
    ///
    /// The listings a seller has already paid for with their own time and not
    /// yet made money from. It was three taps and invisible from Home.
    case inventoryDrafts

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

    // MARK: - Cold-launch persistence (US-1410)

    /// App Intents (Siri / Shortcuts / Spotlight) cold-launch the app and `post`
    /// their route immediately in `perform()` — BEFORE `ContentView` subscribes
    /// to `notificationName`, so on a cold launch the route is lost and the user
    /// lands on a bare dashboard instead of (e.g.) the camera. The intents also
    /// persist their route here; the app drains it on startup and replays it.
    /// Only the parameterless navigation routes need this (push/widget links
    /// arrive while the app is already subscribed) — see ``coldLaunchToken``.
    private static let pendingRouteKey = "com.gradethread.app.pendingDeepLinkRoute"

    public static func persistPending(_ route: DeepLinkRoute) {
        guard let token = route.coldLaunchToken else { return }
        UserDefaults.standard.set(token, forKey: pendingRouteKey)
    }

    /// Returns and clears a persisted cold-launch route, if any.
    public static func drainPending() -> DeepLinkRoute? {
        guard let token = UserDefaults.standard.string(forKey: pendingRouteKey) else { return nil }
        UserDefaults.standard.removeObject(forKey: pendingRouteKey)
        return DeepLinkRoute(coldLaunchToken: token)
    }

    /// Clears any persisted route without consuming it — called after the live
    /// (warm) path handles a posted route, so a warm intent doesn't leave a stale
    /// token that would replay on the next unrelated cold launch.
    public static func clearPending() {
        UserDefaults.standard.removeObject(forKey: pendingRouteKey)
    }
}

extension DeepLinkRoute {
    /// Stable token for the parameterless navigation routes that App Intents
    /// cold-launch the app with (US-1410). Only these round-trip through
    /// cold-launch persistence; everything else returns nil.
    var coldLaunchToken: String? {
        switch self {
        case .captureItem: return "captureItem"
        case .addItem: return "addItem"
        // US-3101: a home-screen quick action or a Lock Screen widget tap on a
        // KILLED app is a cold launch by definition — it is the whole reason
        // someone long-presses the icon. Without a token these three post into
        // a bus nothing is subscribed to yet and the seller lands on a bare
        // Home, which is the exact bug US-1410 fixed for Siri.
        case .prospect: return "prospect"
        case .scout: return "scout"
        case .inventoryDrafts: return "inventoryDrafts"
        default: return nil
        }
    }

    init?(coldLaunchToken token: String) {
        switch token {
        case "captureItem": self = .captureItem
        case "addItem": self = .addItem
        case "prospect": self = .prospect
        case "scout": self = .scout
        case "inventoryDrafts": self = .inventoryDrafts
        default: return nil
        }
    }
}
