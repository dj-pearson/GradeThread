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
                // BOTH, same as a home-screen quick action. `post` serves the
                // warm case; `persistPending` serves the cold one, which is the
                // case a push tap usually IS — the delegate is assigned in
                // `didFinishLaunchingWithOptions` and iOS delivers this
                // response before `ContentView` subscribes, so the live post
                // has no listener. ContentView drains the token in `.task` and
                // the warm path clears it, so exactly one of the two fires.
                DeepLinkRouter.post(route)
                DeepLinkRouter.persistPending(route)
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
            DeepLinkRouter.persistPending(.reconnectEbay)
            completionHandler()
        case let .deepLink(route):
            DeepLinkRouter.post(route)
            DeepLinkRouter.persistPending(route)
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
    /// US-3144: the listings a sold item still has live on channels only the
    /// seller's own browser can end. Carries the item when the push named one,
    /// so the tap lands on that garment's listings rather than the whole queue —
    /// a seller who sells four things in an afternoon needs to know which.
    case pendingDelists(itemId: String?)
    /// US-3266: the Returns & disputes screen, on the section the push named.
    ///
    /// The six post-order categories used to land on ``marketplacesTab``, which
    /// is the tab that HOLDS this screen and not the screen. That was already
    /// better than where they landed before (nowhere), and still asked a seller
    /// holding a dispute deadline to find a card.
    case postSale(section: PostSaleSection)

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
        case NotificationCategoryID.delistNeeded.rawValue:
            // US-3144: always routable, with or without an item. Without one the
            // seller still lands on the full pending list, which is the right
            // answer — there is nothing else this push could have meant.
            return .pendingDelists(itemId: itemId)
        // The post-order family. Returns, inquiries, cases, cancellations and
        // payment disputes all live on one screen behind the Marketplaces tab
        // ("Returns & disputes", `MarketplacesView.postSaleCard`), so every one
        // of them lands there. Before this they landed nowhere at all: the
        // category was unknown, so the tap opened whatever tab the app was last
        // on. Landing on the tab is one tap short of the exact row; landing on
        // nothing is the whole notification wasted, and these are the ones with
        // a clock on them.
        // Returns, inquiries and cases are all handled on the Returns segment:
        // eBay models an inquiry and a case as escalations OF a return-shaped
        // claim, and `PostSaleStore.returns` is what holds them.
        case NotificationCategoryID.returnOpened.rawValue,
             NotificationCategoryID.inquiryOpened.rawValue,
             NotificationCategoryID.caseOpened.rawValue:
            return .postSale(section: .returns)
        case NotificationCategoryID.cancellationRequested.rawValue:
            return .postSale(section: .cancellations)
        case NotificationCategoryID.disputeOpened.rawValue:
            return .postSale(section: .disputes)
        case NotificationCategoryID.caseDeadline.rawValue:
            // The deadline reminder does not say WHICH case, and the payload
            // carries no id (`transactional-push.ts:167`, data is `{ kind }`
            // only). Returns is where a case lives, and the segment labels
            // carry counts (US-1178), so the other two are one tap away and
            // visibly non-empty if that is where the deadline actually is.
            return .postSale(section: .returns)
        case NotificationCategoryID.offerResponded.rawValue:
            // A reply to an offer is the same thread as the offer itself, so it
            // opens the same inbox `offerReceived` does.
            return .negotiationInbox(filterItemId: itemId)
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

    /// Every cold-launch entry point posts its route BEFORE `ContentView`
    /// subscribes to `notificationName`, so the live post is lost and the user
    /// lands on a bare dashboard. App Intents (Siri, Shortcuts, Spotlight) do it
    /// from `perform()`; home-screen quick actions do it from the app delegate;
    /// and a push tap does it from `didReceive response`, which iOS delivers as
    /// soon as the delegate is assigned in `didFinishLaunchingWithOptions`.
    /// All three also persist here, and the app drains the token on startup.
    ///
    /// The "only parameterless routes need this" rule this file used to state
    /// was wrong about the commonest case of all: a tap on "Your item sold"
    /// with the app killed. Ids round-trip now. See ``coldLaunchToken``.
    private static let pendingRouteKey = "com.gradethread.app.pendingDeepLinkRoute"

    /// How long a persisted route stays replayable.
    ///
    /// A token can be stranded: the tap cold-launches the app, the user is
    /// signed out, they never finish sign-in, and nothing drains it. Without a
    /// clock that token replays on the NEXT unrelated launch, and "open the
    /// offer on this item" is a worse answer three days late than not at all.
    /// Ten minutes is longer than any launch and shorter than any session gap.
    private static let pendingRouteTTL: TimeInterval = 600

    public static func persistPending(_ route: DeepLinkRoute, now: Date = Date()) {
        guard let token = route.coldLaunchToken else { return }
        // One defaults key, not two — `AccountScopedDefaults` classifies keys by
        // name, so a second key would be a second thing to remember to wipe on
        // sign-out. The stamp rides in the value.
        UserDefaults.standard.set("\(Int(now.timeIntervalSince1970))#\(token)", forKey: pendingRouteKey)
    }

    /// Returns and clears a persisted cold-launch route, if any.
    public static func drainPending(now: Date = Date()) -> DeepLinkRoute? {
        guard let stored = UserDefaults.standard.string(forKey: pendingRouteKey) else { return nil }
        UserDefaults.standard.removeObject(forKey: pendingRouteKey)
        let parts = stored.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
        // A value written by a build before the stamp existed is a bare token.
        // Honor it once rather than dropping the upgrade user's tap on the floor.
        guard parts.count == 2, let stamp = TimeInterval(parts[0]) else {
            return DeepLinkRoute(coldLaunchToken: stored)
        }
        guard now.timeIntervalSince1970 - stamp <= pendingRouteTTL else { return nil }
        return DeepLinkRoute(coldLaunchToken: String(parts[1]))
    }

    /// Clears any persisted route without consuming it — called after the live
    /// (warm) path handles a posted route, so a warm intent doesn't leave a stale
    /// token that would replay on the next unrelated cold launch.
    public static func clearPending() {
        UserDefaults.standard.removeObject(forKey: pendingRouteKey)
    }
}

extension DeepLinkRoute {
    /// Separator between a route's name and the id it carries. Not present in
    /// any id we mint (they are UUIDs and eBay offer ids), and `maxSplits: 1`
    /// means an id that somehow contained one would still round-trip.
    private static let tokenSeparator: Character = "|"

    private static func token(_ name: String, _ id: String?) -> String {
        guard let id, !id.isEmpty else { return name }
        return "\(name)\(tokenSeparator)\(id)"
    }

    /// Stable token for cold-launch persistence (US-1410).
    ///
    /// ⚠ THIS USED TO COVER ONLY THE PARAMETERLESS ROUTES, on the stated
    /// grounds that "push/widget links arrive while the app is already
    /// subscribed". That is false for the launch a push most often causes.
    /// `UNUserNotificationCenter.delegate` is assigned in
    /// `didFinishLaunchingWithOptions`, and iOS delivers the tap response as
    /// soon as it is — BEFORE SwiftUI mounts `ContentView` and its `.onReceive`
    /// subscribes. So tapping "Your item sold" on a killed app posted into an
    /// empty bus and landed the seller on Home with no idea what sold.
    /// Every route round-trips now, ids included.
    var coldLaunchToken: String? {
        switch self {
        case .captureItem: return "captureItem"
        case .addItem: return "addItem"
        case .prospect: return "prospect"
        case .scout: return "scout"
        case .inventoryDrafts: return "inventoryDrafts"
        case .marketplacesTab: return "marketplacesTab"
        case .reconnectEbay: return "reconnectEbay"
        case .inventoryTab: return "inventoryTab"
        case .gradesList: return "gradesList"
        case let .salesTab(id): return Self.token("salesTab", id)
        case let .inventoryItem(id): return Self.token("inventoryItem", id)
        case let .negotiationInbox(id): return Self.token("negotiationInbox", id)
        case let .supportTickets(id): return Self.token("supportTickets", id)
        case let .pendingDelists(id): return Self.token("pendingDelists", id)
        case let .postSale(section): return Self.token("postSale", section.rawValue)
        }
    }

    init?(coldLaunchToken token: String) {
        let parts = token.split(
            separator: Self.tokenSeparator, maxSplits: 1, omittingEmptySubsequences: false)
        guard let head = parts.first, !head.isEmpty else { return nil }
        let name = String(head)
        let id = parts.count > 1 && !parts[1].isEmpty ? String(parts[1]) : nil
        switch name {
        case "captureItem": self = .captureItem
        case "addItem": self = .addItem
        case "prospect": self = .prospect
        case "scout": self = .scout
        case "inventoryDrafts": self = .inventoryDrafts
        case "marketplacesTab": self = .marketplacesTab
        case "reconnectEbay": self = .reconnectEbay
        case "inventoryTab": self = .inventoryTab
        case "gradesList": self = .gradesList
        case "salesTab": self = .salesTab(inventoryItemId: id)
        case "negotiationInbox": self = .negotiationInbox(filterItemId: id)
        case "supportTickets": self = .supportTickets(ticketId: id)
        case "pendingDelists": self = .pendingDelists(itemId: id)
        // The only case whose id is NOT optional: without one there is no item
        // to open, so refuse rather than invent a destination.
        case "inventoryItem":
            guard let id else { return nil }
            self = .inventoryItem(id: id)
        case "postSale":
            // A token naming a section this build no longer has is refused
            // rather than defaulted: landing on Returns because "chargebacks"
            // did not parse is a wrong answer wearing a right one's clothes.
            guard let id, let section = PostSaleSection(rawValue: id) else { return nil }
            self = .postSale(section: section)
        default: return nil
        }
    }
}
